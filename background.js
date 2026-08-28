try {
  importScripts('utils/runtime-config.js');
} catch (error) {
  console.warn('[onstarvoice] runtime config unavailable; using production API defaults', error);
}

try {
  importScripts('utils/task-center.js');
} catch (error) {
  // 测试或旧交付快照中可能暂时没有任务中心脚本。后台可靠性逻辑仍可运行，
  // 等脚本可用后会自动把同一份请求镜像到任务账本。
  console.warn('[onstarvoice] task center core unavailable', error);
}

try {
  importScripts('utils/cloud-task-agent.js');
} catch (error) {
  console.warn('[onstarvoice] cloud task agent unavailable', error);
}

try {
  importScripts('utils/cloud-targeted-post.js');
} catch (error) {
  console.warn('[onstarvoice] cloud targeted post protocol unavailable', error);
}

importScripts(
  'utils/control-storage-reserve.js',
  'utils/social-account-usage.js',
  'utils/runtime-tab-policy.js',
  'utils/capture/debug-session.js',
  'utils/capture/task-tab-group.js',
  'utils/capture/task-runtime.js',
  'utils/capture/task-owner.js',
);

const runtimeTabPolicy = globalThis.OnStarvoiceRuntimeTabPolicy;
const captureTaskTabGroupApi = globalThis.OnStarvoiceCaptureTaskTabGroup;
const cloudTaskAgentApi = globalThis.OnStarvoiceCloudTaskAgent;
const cloudTargetedPostApi = globalThis.OnStarvoiceCloudTargetedPost;
const socialAccountUsageApi = globalThis.OnStarvoiceSocialAccountUsage;
const controlStorageReserveApi =
  globalThis.OnStarvoiceControlStorageReserve;
if (!controlStorageReserveApi) {
  throw new Error('Control storage reserve helper is unavailable');
}
const CAPTURE_TASK_GROUP_TITLE =
  captureTaskTabGroupApi.DEFAULT_GROUP_TITLE || 'StarVoice 采集任务';

const STORAGE_KEYS = {
  runtime: 'onstarvoice.runtime',
  unattendedKeywordPlan: 'onstarvoice.unattendedKeywordPlan',
  unattendedKeywordRunRequest: 'onstarvoice.unattendedKeywordRunRequest',
  unattendedKeywordRunArchive: 'onstarvoice.unattendedKeywordRunArchive',
  captureExecutionLock: 'onstarvoice.captureExecutionLock',
  taskLedger: 'onstarvoice.taskLedger',
  syncHistory: 'onstarvoice.sync_history',
  auth: 'onstarvoice.auth',
  cloudCommandResults: 'onstarvoice.cloudCommandResults',
  cloudAgentStatus: 'onstarvoice.cloudTaskAgentStatus',
  targetedPostRunRequest: 'onstarvoice.targetedPostRunRequest',
  observedSocialAccounts: 'onstarvoice.observedSocialAccounts',
  socialAccountUsageQueue: 'onstarvoice.socialAccountUsageQueue',
  diagnostics: 'onstarvoice.diagnostics',
};

const CONTROL_STORAGE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const TASK_LEDGER_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLOUD_COMMAND_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const AUTHORITATIVE_CONTROL_TERMINAL_STATUSES = new Set([
  'completed',
  'completed_with_warnings',
  'completed_with_failures',
  'failed',
  'canceled',
  'skipped',
  'needs_action',
]);

async function runAuthoritativeControlStorageMutation(
  mutation,
  {relieveStoragePressure = false} = {},
) {
  const result =
    await controlStorageReserveApi.runWithControlStorageReserveRetry(
      mutation,
      {
        storage: chrome.storage.local,
        ...(relieveStoragePressure
          ? {
              onQuotaPressure: () => compactExpiredControlStorage({
                force: true,
                reason: 'quota_pressure',
              }),
            }
          : {}),
      },
    );
  return result.value;
}

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
  captureDebugSession: null,
  captureTaskCancellation: null,
  lastPageUrl: '',
};

const UNATTENDED_KEYWORD_ALARM_NAME = 'onstarvoice:unattended-keyword-plan';
const UNATTENDED_SUPERVISOR_ALARM_NAME = 'onstarvoice:unattended-supervisor';
const CLOUD_TASK_AGENT_ALARM_NAME = 'onstarvoice:cloud-task-agent';
const UNATTENDED_RUNNER_QUERY_KEY = 'unattendedRun';
const UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY = 'unattendedAttempt';
const UNATTENDED_CHECKPOINT_OUTBOX_STORAGE_PREFIX =
  'onstarvoice.unattendedCheckpointReportOutbox.v2.';
const UNATTENDED_LOCAL_CLOSURE_EVIDENCE_VERSION = 1;
const TARGETED_POST_RUNNER_QUERY_KEY = 'targetedPostRun';
const TARGETED_POST_RUNNER_ATTEMPT_QUERY_KEY = 'targetedPostAttempt';
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
const TASK_LEDGER_STALE_ACTIVE_MS = 10 * 60 * 1000;
const TASK_CENTER_RECENT_ACTIVITY_MS = 2 * 60 * 1000;
const UNATTENDED_LOCK_RETRY_DELAY_MS = 5 * 60 * 1000;
const UNATTENDED_RUN_CLAIM_GRACE_MS = 2 * 60 * 1000;
const UNATTENDED_RUN_ACTIVE_GRACE_MS = 3 * 60 * 1000;
const UNATTENDED_RUN_BUSINESS_STALL_MS = 6 * 60 * 1000;
const UNATTENDED_SUPERVISOR_PERIOD_MINUTES = 1;
const CLOUD_TASK_AGENT_PERIOD_MINUTES = 1;
const CLOUD_TASK_AGENT_ACTIVE_THROTTLE_MS = 15 * 1000;
const CLOUD_TASK_AGENT_FAILURE_BACKOFF_BASE_MS = 15 * 1000;
const CLOUD_TASK_AGENT_FAILURE_BACKOFF_MAX_MS = 5 * 60 * 1000;
const SOCIAL_ACCOUNT_IDENTITY_REFRESH_MS = 5 * 60 * 1000;
const SOCIAL_ACCOUNT_IDENTITY_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
const UNATTENDED_SUPERVISOR_SUSPEND_GAP_MS = 2.5 * 60 * 1000;
const UNATTENDED_SUPERVISOR_WAKE_GRACE_MS = 2 * 60 * 1000;
const UNATTENDED_SUPERVISOR_LOCK_WAIT_MS = 5 * 60 * 1000;
const UNATTENDED_RUN_SCHEMA_VERSION = 2;
const UNATTENDED_RUN_ARCHIVE_LIMIT = 50;
const UNATTENDED_RUN_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UNATTENDED_MAX_RECOVERY_ATTEMPTS = 4;
const UNATTENDED_RECOVERY_RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
]);
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
// These states may still be retried. Before a terminal request releases the
// single execution slot, retain its full plan/checkpoint in the bounded archive
// so a later "continue" or "retry failed" action can reconstruct it exactly.
const UNATTENDED_RUN_RETRYABLE_STATUSES = new Set([
  'interrupted',
  'needs_action',
  'failed',
  'completed_with_failures',
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
let captureDebugSessionManager = null;
let captureTaskTabGroupManager = null;
let captureTaskOwnerCoordinator = null;
const CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS = 10 * 60 * 1000;
const captureTaskReplacementTabIds = new Map();
const captureTaskPendingWorkerTabIds = new Map();
const captureTaskCleanupInProgress = new Set();
let captureTaskBeginInFlight = null;

function pruneCaptureTaskReplacementTabs(now = Date.now()) {
  for (const [tabId, replacement] of captureTaskReplacementTabIds) {
    if (Number(replacement?.expiresAt) <= now) {
      captureTaskReplacementTabIds.delete(tabId);
    }
  }
}

function rememberCaptureTaskReplacementTab({
  removedTabId,
  addedTabId,
  taskId,
  attemptId = '',
} = {}) {
  const oldTabId = resolveCaptureTaskTabId(removedTabId);
  const newTabId = resolveCaptureTaskTabId(addedTabId);
  const normalizedTaskId = String(taskId || '').trim();
  if (!oldTabId || !newTabId || !normalizedTaskId) return false;
  pruneCaptureTaskReplacementTabs();
  captureTaskReplacementTabIds.set(oldTabId, {
    tabId: newTabId,
    taskId: normalizedTaskId,
    attemptId: String(attemptId || '').trim(),
    expiresAt: Date.now() + CAPTURE_TASK_REPLACEMENT_TAB_TTL_MS,
  });
  return true;
}

function resolveCaptureTaskReplacementLease(
  tabId,
  {taskId = '', attemptId = ''} = {},
) {
  const originalTabId = resolveCaptureTaskTabId(tabId);
  const requestedTaskId = String(taskId || '').trim();
  const requestedAttemptId = String(attemptId || '').trim();
  if (!originalTabId) return null;
  pruneCaptureTaskReplacementTabs();

  let replacementTabId = originalTabId;
  let replacementTaskId = requestedTaskId;
  let replacementAttemptId = requestedAttemptId;
  const visited = new Set([originalTabId]);
  for (let depth = 0; depth < 8; depth += 1) {
    const replacement = captureTaskReplacementTabIds.get(replacementTabId);
    if (!replacement) break;
    if (
      replacementTaskId &&
      replacement.taskId !== replacementTaskId
    ) {
      return null;
    }
    if (
      replacementAttemptId &&
      String(replacement.attemptId || '').trim() !== replacementAttemptId
    ) {
      return null;
    }
    replacementTaskId = replacementTaskId || replacement.taskId;
    replacementAttemptId =
      replacementAttemptId || String(replacement.attemptId || '').trim();
    replacementTabId = resolveCaptureTaskTabId(replacement.tabId);
    if (!replacementTabId || visited.has(replacementTabId)) return null;
    visited.add(replacementTabId);
  }
  if (replacementTabId === originalTabId || !replacementTaskId) return null;

  return {
    tabId: replacementTabId,
    taskId: replacementTaskId,
    attemptId: replacementAttemptId,
  };
}

function resolveCaptureTaskReplacementTab(tabId, taskId = '') {
  const replacement = resolveCaptureTaskReplacementLease(tabId, {taskId});
  if (!replacement) return null;

  const group = captureTaskTabGroupManager?.getTask(replacement.taskId);
  if (
    !group ||
    (
      Number(group.sourceTabId) !== replacement.tabId &&
      !group.workerTabIds?.includes(replacement.tabId)
    )
  ) {
    return null;
  }
  return replacement;
}
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

function normalizeCalendarDate(value) {
  const match = String(value || '').trim().match(
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

function normalizeDateListText(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,，;；]+/g)
        .map(normalizeCalendarDate)
        .filter(Boolean),
    ),
  ).join('\n');
}

function normalizeUnattendedRunProgress(progress = null, fallbackMessage = '') {
  if (!progress || typeof progress !== 'object') {
    return null;
  }
  const optionalNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const current = Number(progress.current);
  const total = Number(progress.total);
  const round = optionalNumber(progress.round);
  const roundCurrent = optionalNumber(progress.roundCurrent ?? progress.round);
  const roundTotal = optionalNumber(progress.roundTotal);
  const keywordCurrent = optionalNumber(progress.keywordCurrent);
  const keywordTotal = optionalNumber(progress.keywordTotal);
  const itemCurrent = optionalNumber(progress.itemCurrent);
  const itemTotal = optionalNumber(progress.itemTotal);
  const attemptCurrent = optionalNumber(
    progress.attemptCurrent ?? progress.attempt,
  );
  const attemptTotal = optionalNumber(
    progress.attemptTotal ?? progress.maxAttempts,
  );
  const runnerTabId = Number(progress.runnerTabId);
  const remainingMs = Number(progress.remainingMs);
  const numericProgressFields = [
    'detectedCount',
    'markedCount',
    'filteredCount',
    'aiFilteredCount',
    'candidateCount',
    'evaluatedCount',
    'failedOpenCount',
    'retryCount',
    'retriedItemCount',
    'timeoutCount',
    'noEnhancementCount',
    'successCount',
    'failedCount',
    'skippedCount',
    'detailSuccessCount',
    'detailFailedCount',
    'syncSuccessCount',
    'syncFailedCount',
    'syncSkippedCount',
    'syncRemainingCount',
    'streamingSyncEnqueuedCount',
    'streamingSyncProcessedCount',
    'streamingSyncSuccessCount',
    'streamingSyncFailedCount',
    'streamingSyncSkippedCount',
    'streamingSyncPendingCount',
    'streamingSyncActiveCount',
    'streamingSyncRemainingCount',
    'capturedRecordCount',
    'keywordCompletedCount',
    'keywordPartialCount',
    'keywordFailedCount',
    'keywordSkippedCount',
    'progressPercent',
    'collectedCount',
    'savedCount',
    'commentsCount',
    'followersCount',
    'bloggerFollowersCount',
  ];
  const normalizedCounts = numericProgressFields.reduce((result, field) => {
    if (
      progress[field] === null ||
      progress[field] === undefined ||
      progress[field] === ''
    ) {
      return result;
    }
    const value = Number(progress[field]);
    if (Number.isFinite(value)) {
      result[field] = value;
    }
    return result;
  }, {});
  const taskMeta =
    progress.taskMeta &&
    typeof progress.taskMeta === 'object' &&
    !Array.isArray(progress.taskMeta)
      ? {
          keywordList: Array.isArray(progress.taskMeta.keywordList)
            ? progress.taskMeta.keywordList
                .map((keyword) => String(keyword || '').trim().slice(0, 120))
                .filter(Boolean)
                .slice(0, 30)
            : [],
          searchFilters:
            progress.taskMeta.searchFilters &&
            typeof progress.taskMeta.searchFilters === 'object'
              ? Object.fromEntries(
                  Object.entries(progress.taskMeta.searchFilters)
                    .slice(0, 12)
                    .map(([field, value]) => [
                      String(field || '').slice(0, 40),
                      String(value || '').slice(0, 80),
                    ]),
                )
              : {},
          enhancementEnabled: Boolean(progress.taskMeta.enhancementEnabled),
          aiRelevancePrefilterEnabled: Boolean(
            progress.taskMeta.aiRelevancePrefilterEnabled,
          ),
          commentsEnabled: Boolean(progress.taskMeta.commentsEnabled),
          bloggerMetricsEnabled: Boolean(progress.taskMeta.bloggerMetricsEnabled),
        }
      : null;
  return {
    current: Number.isFinite(current) ? current : 0,
    total: Number.isFinite(total) ? total : 0,
    captureTaskId: String(progress.captureTaskId || ''),
    unattendedRequestId: String(progress.unattendedRequestId || ''),
    unattendedAttemptId: String(progress.unattendedAttemptId || ''),
    finishedAt: String(progress.finishedAt || ''),
    keyword: String(progress.keyword || ''),
    keywordCurrent: Number.isFinite(keywordCurrent) ? keywordCurrent : null,
    keywordTotal: Number.isFinite(keywordTotal) ? keywordTotal : null,
    itemCurrent: Number.isFinite(itemCurrent) ? itemCurrent : null,
    itemTotal: Number.isFinite(itemTotal) ? itemTotal : null,
    nextKeyword: String(progress.nextKeyword || ''),
    runStartedAt: String(progress.runStartedAt || ''),
    progressScope: String(progress.progressScope || ''),
    phase: String(progress.phase || ''),
    round,
    roundCurrent,
    roundTotal,
    attemptCurrent,
    attemptTotal,
    runnerTabId: Number.isFinite(runnerTabId) && runnerTabId > 0 ? runnerTabId : null,
    recordId: String(progress.recordId || ''),
    remainingMs: Number.isFinite(remainingMs) ? remainingMs : null,
    waitUntil: String(progress.waitUntil || ''),
    message: String(progress.message || fallbackMessage || ''),
    phaseStartedAt: String(progress.phaseStartedAt || ''),
    updatedAt: String(progress.updatedAt || new Date().toISOString()),
    workerMode: String(progress.workerMode || ''),
    workerStates: Array.isArray(progress.workerStates)
      ? progress.workerStates
          .filter((worker) => worker && typeof worker === 'object')
          .slice(0, 2)
          .map((worker) => ({
            id: String(worker.id || worker.key || ''),
            label: String(worker.label || ''),
            state: String(worker.state || ''),
            detail: String(worker.detail || worker.message || ''),
          }))
      : [],
    taskMeta,
    streamingSyncEvidenceKnown:
      typeof progress.streamingSyncEvidenceKnown === 'boolean'
        ? progress.streamingSyncEvidenceKnown
        : null,
    streamingSyncDrainCompleted:
      typeof progress.streamingSyncDrainCompleted === 'boolean'
        ? progress.streamingSyncDrainCompleted
        : null,
    streamingSyncEnabled:
      typeof progress.streamingSyncEnabled === 'boolean'
        ? progress.streamingSyncEnabled
        : null,
    streamingSyncBlocked:
      typeof progress.streamingSyncBlocked === 'boolean'
        ? progress.streamingSyncBlocked
        : null,
    streamingSyncCanceled:
      typeof progress.streamingSyncCanceled === 'boolean'
        ? progress.streamingSyncCanceled
        : null,
    ...normalizedCounts,
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
  const rawKeywordMaxDetectedItems = Number(base.keywordMaxDetectedItems);
  const hasKeywordMaxDetectedItems =
    Object.prototype.hasOwnProperty.call(base, 'keywordMaxDetectedItems') &&
    Number.isSafeInteger(rawKeywordMaxDetectedItems) &&
    rawKeywordMaxDetectedItems > 0;
  const normalizedPlan = {
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
  if (hasKeywordMaxDetectedItems) {
    normalizedPlan.keywordMaxDetectedItems = rawKeywordMaxDetectedItems;
  } else {
    delete normalizedPlan.keywordMaxDetectedItems;
  }
  return normalizedPlan;
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
let unattendedRunArchiveMutationQueue = Promise.resolve();
let unattendedRunnerTabLifecycleQueue = Promise.resolve();
let taskLedgerMutationQueue = Promise.resolve();
let captureTaskBeginQueue = Promise.resolve();
let targetedPostRunMutationQueue = Promise.resolve();
let cloudCommandResultsMutationQueue = Promise.resolve();

function runUnattendedRunMutation(operation) {
  const pending = unattendedRunMutationQueue.then(operation, operation);
  unattendedRunMutationQueue = pending.catch(() => null);
  return pending;
}

function runUnattendedRunArchiveMutation(operation) {
  const pending = unattendedRunArchiveMutationQueue.then(operation, operation);
  unattendedRunArchiveMutationQueue = pending.catch(() => null);
  return pending;
}

function runUnattendedRunnerTabLifecycle(operation) {
  const pending = unattendedRunnerTabLifecycleQueue.then(operation, operation);
  unattendedRunnerTabLifecycleQueue = pending.catch(() => null);
  return pending;
}

function runTaskLedgerMutation(operation) {
  const pending = taskLedgerMutationQueue.then(operation, operation);
  taskLedgerMutationQueue = pending.catch(() => null);
  return pending;
}

function runCaptureTaskBeginOperation(operation) {
  const pending = captureTaskBeginQueue.then(operation, operation);
  captureTaskBeginQueue = pending.catch(() => null);
  return pending;
}

function runTargetedPostRunMutation(operation) {
  const pending = targetedPostRunMutationQueue.then(operation, operation);
  targetedPostRunMutationQueue = pending.catch(() => null);
  return pending;
}

function runCloudCommandResultsMutation(operation) {
  const pending = cloudCommandResultsMutationQueue.then(operation, operation);
  cloudCommandResultsMutationQueue = pending.catch(() => null);
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

function normalizeOrchestrationExecutionContext(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parentTaskId = String(source.parentTaskId || '').trim().slice(0, 100);
  if (!parentTaskId) return null;
  const distributionMode =
    String(source.distributionMode || '').trim() === 'elastic_pool'
      ? 'elastic_pool'
      : '';
  const itemIds = Array.from(
    new Set(
      (Array.isArray(source.itemIds) ? source.itemIds : [])
        .map((itemId) => String(itemId || '').trim().slice(0, 100))
        .filter(Boolean),
    ),
  ).slice(0, 30);
  const itemAttempts = (Array.isArray(source.itemAttempts)
    ? source.itemAttempts
    : [])
    .slice(0, 30)
    .map((entry) => {
      const attempt =
        entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      return {
        itemId: String(attempt.itemId || '').trim().slice(0, 100),
        attemptId: String(
          attempt.attemptId || attempt.captureTaskItemAttemptId || '',
        ).trim().slice(0, 100),
        requestHash: String(
          attempt.requestHash || attempt.captureTaskItemRequestHash || '',
        ).trim().slice(0, 100),
        keyword: String(attempt.keyword || '').trim().slice(0, 120),
        recordId: String(attempt.recordId || '').trim().slice(0, 100),
        externalId: String(attempt.externalId || '').trim().slice(0, 160),
        attemptNumber: Math.max(
          0,
          Math.floor(Number(attempt.attemptNumber) || 0),
        ),
        assignmentRevision: Math.max(
          0,
          Math.floor(Number(attempt.assignmentRevision) || 0),
        ),
      };
    })
    .filter((attempt) => attempt.itemId && attempt.attemptId);
  const attemptIdentity = String(
    source.attemptIdentity || source.attempt_identity || '',
  ).trim().slice(0, 100);
  const bootstrapStartAt = Date.parse(
    String(
      source.bootstrapStartNotBefore ||
        source.bootstrap_start_not_before ||
        '',
    ),
  );
  const bootstrapStartNotBefore = Number.isFinite(bootstrapStartAt)
    ? new Date(bootstrapStartAt).toISOString()
    : '';
  const bootstrapDelayMs = Math.max(
    0,
    Math.min(60 * 1000, Math.floor(Number(source.bootstrapDelayMs) || 0)),
  );
  const bootstrapStaggerBucket = Math.max(
    0,
    Math.min(20, Math.floor(Number(source.bootstrapStaggerBucket) || 0)),
  );
  const recentTechnicalFailureCount = Math.max(
    0,
    Math.min(100, Math.floor(Number(source.recentTechnicalFailureCount) || 0)),
  );
  const recentAffectedAgentCount = Math.max(
    0,
    Math.min(100, Math.floor(Number(source.recentAffectedAgentCount) || 0)),
  );
  return {
    parentTaskId,
    revision: Math.max(0, Math.floor(Number(source.revision) || 0)),
    itemIds,
    ...(itemAttempts.length > 0 ? {itemAttempts} : {}),
    ...(distributionMode ? {distributionMode} : {}),
    ...(attemptIdentity ? {attemptIdentity} : {}),
    ...(bootstrapStartNotBefore ? {bootstrapStartNotBefore} : {}),
    ...(bootstrapDelayMs ? {bootstrapDelayMs} : {}),
    ...(bootstrapStartNotBefore
      ? {
          bootstrapPacingReason: String(
            source.bootstrapPacingReason || '',
          ).trim().slice(0, 80),
          bootstrapStaggerBucket,
          recentTechnicalFailureCount,
          recentAffectedAgentCount,
        }
      : {}),
    scheduleId: String(source.scheduleId || '').trim().slice(0, 100),
    scheduledFor: String(source.scheduledFor || '').trim().slice(0, 100),
    sourceExecutionTaskId: String(
      source.sourceExecutionTaskId ||
        source.handoffSourceExecutionTaskId ||
        source.retrySourceExecutionTaskId ||
        '',
    ).trim().slice(0, 100),
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

function isRetryableUnattendedRunRequest(request) {
  return Boolean(
    request &&
      UNATTENDED_RUN_RETRYABLE_STATUSES.has(String(request.status || '')) &&
      !String(request.recoveryDismissedAt || '').trim(),
  );
}

function normalizeUnattendedKeywordRunArchive(
  value,
  now = Date.now(),
  expectedAgentScopeId = '',
) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const archiveAgentScopeId = String(source.agentScopeId || '').trim();
  const normalizedExpectedScopeId = String(expectedAgentScopeId || '').trim();
  const archiveScopeMatches =
    !archiveAgentScopeId ||
    !normalizedExpectedScopeId ||
    archiveAgentScopeId === normalizedExpectedScopeId;
  const rawRequests =
    archiveScopeMatches &&
    source.requests &&
    typeof source.requests === 'object' &&
    !Array.isArray(source.requests)
      ? source.requests
      : {};
  const requests = Object.fromEntries(
    Object.values(rawRequests)
      .map((request) => normalizeUnattendedRunRequest(request))
      .filter((request) => {
        if (!isRetryableUnattendedRunRequest(request)) return false;
        const requestAgentScopeId = String(
          request.cloudAgentScopeId || '',
        ).trim();
        if (
          requestAgentScopeId &&
          normalizedExpectedScopeId &&
          requestAgentScopeId !== normalizedExpectedScopeId
        ) {
          return false;
        }
        const archivedAt = parseTimestampMs(
          request.archivedAt ||
            request.finishedAt ||
            request.updatedAt ||
            request.createdAt,
        );
        return (
          !Number.isFinite(archivedAt) ||
          now - archivedAt <= UNATTENDED_RUN_ARCHIVE_RETENTION_MS
        );
      })
      .sort((left, right) => {
        const rightAt = parseTimestampMs(
          right.archivedAt || right.finishedAt || right.updatedAt,
        );
        const leftAt = parseTimestampMs(
          left.archivedAt || left.finishedAt || left.updatedAt,
        );
        return (Number.isFinite(rightAt) ? rightAt : 0) -
          (Number.isFinite(leftAt) ? leftAt : 0);
      })
      .slice(0, UNATTENDED_RUN_ARCHIVE_LIMIT)
      .map((request) => [request.id, request]),
  );
  return {
    version: 1,
    agentScopeId: archiveScopeMatches
      ? archiveAgentScopeId || normalizedExpectedScopeId
      : normalizedExpectedScopeId,
    requests,
    updatedAt: String(source.updatedAt || ''),
  };
}

async function readUnattendedKeywordRunArchive() {
  const [stored, credential] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.unattendedKeywordRunArchive),
    readCloudTaskAgentCredential(),
  ]);
  return normalizeUnattendedKeywordRunArchive(
    stored[STORAGE_KEYS.unattendedKeywordRunArchive],
    Date.now(),
    credential.id,
  );
}

async function readArchivedUnattendedKeywordRunRequest(requestId) {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) return null;
  const archive = await readUnattendedKeywordRunArchive();
  return normalizeUnattendedRunRequest(archive.requests[normalizedRequestId]);
}

async function archiveUnattendedKeywordRunRequest(request) {
  return await runUnattendedRunArchiveMutation(async () => {
    const normalized = normalizeUnattendedRunRequest(request);
    if (!isRetryableUnattendedRunRequest(normalized)) {
      return null;
    }
    const credential = await readCloudTaskAgentCredential();
    const currentAgentScopeId = String(credential.id || '').trim();
    const requestAgentScopeId = String(
      normalized.cloudAgentScopeId || '',
    ).trim();
    if (
      currentAgentScopeId &&
      requestAgentScopeId &&
      currentAgentScopeId !== requestAgentScopeId
    ) {
      return null;
    }
    const scopedRequest = {
      ...normalized,
      cloudAgentScopeId: requestAgentScopeId || currentAgentScopeId,
    };
    const archive = await readUnattendedKeywordRunArchive();
    const now = new Date().toISOString();
    const next = normalizeUnattendedKeywordRunArchive({
      ...archive,
      agentScopeId: currentAgentScopeId || requestAgentScopeId,
      requests: {
        ...archive.requests,
        [scopedRequest.id]: {
          ...scopedRequest,
          archivedAt: now,
        },
      },
      updatedAt: now,
    }, Date.now(), currentAgentScopeId);
    await chrome.storage.local.set({
      [STORAGE_KEYS.unattendedKeywordRunArchive]: next,
    });
    return next.requests[scopedRequest.id] || null;
  });
}

async function removeArchivedUnattendedKeywordRunRequest(requestId) {
  return await runUnattendedRunArchiveMutation(async () => {
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedRequestId) return false;
    const archive = await readUnattendedKeywordRunArchive();
    if (!archive.requests[normalizedRequestId]) return false;
    const requests = {...archive.requests};
    delete requests[normalizedRequestId];
    await chrome.storage.local.set({
      [STORAGE_KEYS.unattendedKeywordRunArchive]: {
        ...archive,
        requests,
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  });
}

async function clearUnattendedKeywordRunArchive() {
  return await runUnattendedRunArchiveMutation(async () => {
    await chrome.storage.local.remove(
      STORAGE_KEYS.unattendedKeywordRunArchive,
    );
    return true;
  });
}

function isTerminalUnattendedRunStatus(status) {
  return UNATTENDED_RUN_TERMINAL_STATUSES.has(String(status || ''));
}

function getUnattendedExecutionMode(source = {}) {
  const value =
    typeof source === 'string' ? source : source?.executionMode;
  return String(value || '').trim() === 'one_time'
    ? 'one_time'
    : 'unattended_plan';
}

function getUnattendedExecutionCopy(source = {}) {
  const executionMode = getUnattendedExecutionMode(source);
  const oneTime = executionMode === 'one_time';
  const orchestrationRun = Boolean(
    source &&
      typeof source === 'object' &&
      normalizeOrchestrationExecutionContext(source.orchestrationContext),
  );
  return {
    executionMode,
    taskLabel: orchestrationRun
      ? '无人值守计划执行批次'
      : oneTime
        ? '一次性采集任务'
        : '无人值守任务',
    runLabel: orchestrationRun
      ? '无人值守计划运行批次'
      : oneTime
        ? '一次性采集'
        : '无人值守运行',
    runnerLabel: orchestrationRun
      ? '无人值守计划运行页'
      : oneTime
        ? '一次性任务运行页'
        : '无人值守运行页',
  };
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function resolveUnattendedBusinessProgressAt({
  suppliedAt,
  currentAt,
  now,
  hasProgressSequence = false,
} = {}) {
  const nowMs = parseTimestampMs(now);
  const currentMs = parseTimestampMs(currentAt);
  const suppliedMs = parseTimestampMs(suppliedAt);
  if (
    hasProgressSequence &&
    Number.isFinite(suppliedMs) &&
    Number.isFinite(nowMs) &&
    suppliedMs <= nowMs &&
    (!Number.isFinite(currentMs) || suppliedMs >= currentMs)
  ) {
    return new Date(suppliedMs).toISOString();
  }
  if (
    Number.isFinite(suppliedMs) &&
    Number.isFinite(currentMs) &&
    suppliedMs < currentMs
  ) {
    return new Date(currentMs).toISOString();
  }
  return Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : String(now || '');
}

const UNATTENDED_PROGRESS_VOLATILE_FIELDS = new Set([
  'businessProgressAt',
  'elapsedMs',
  'heartbeatAt',
  'remainingMs',
  'runStartedAt',
  'stepStartedAt',
  'updatedAt',
  'waitUntil',
]);

function buildUnattendedBusinessProgressFingerprint(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) {
      return entry.map((item) => normalize(item));
    }
    if (!entry || typeof entry !== 'object') {
      return entry;
    }
    return Object.fromEntries(
      Object.keys(entry)
        .filter((key) => !UNATTENDED_PROGRESS_VOLATILE_FIELDS.has(key))
        .sort()
        .map((key) => [key, normalize(entry[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

const UNATTENDED_SETTLED_CHECKPOINT_STATUSES = new Set([
  'completed',
  'failed',
  'partial',
  'skipped',
]);

function buildUnattendedRecoveryMilestoneFingerprint(checkpoint) {
  const source =
    checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
      ? checkpoint
      : {};
  const keywordResults = Array.isArray(source.keywordResults)
    ? source.keywordResults
        .filter((entry) =>
          UNATTENDED_SETTLED_CHECKPOINT_STATUSES.has(
            String(entry?.status || '').trim().toLowerCase(),
          ),
        )
        .map((entry) => ({
          round: Math.max(1, Number(entry?.round) || 1),
          index: Math.max(0, Number(entry?.index) || 0),
          keyword: String(entry?.keyword || ''),
          status: String(entry?.status || '').trim().toLowerCase(),
          savedCount: Math.max(0, Number(entry?.savedCount) || 0),
          noResults: entry?.noResults === true,
          resultKind: String(entry?.resultKind || ''),
          candidateCount: Math.max(0, Number(entry?.candidateCount) || 0),
          scanComplete: entry?.scanComplete === true,
        }))
    : [];
  const normalizeKeywords = (value) =>
    Array.isArray(value)
      ? value.map((keyword) => String(keyword || '').trim()).filter(Boolean)
      : [];
  return JSON.stringify({
    round: Math.max(1, Number(source.round) || 1),
    keywordResults,
    completedKeywords: normalizeKeywords(source.completedKeywords),
    failedKeywords: normalizeKeywords(source.failedKeywords),
    skippedKeywords: normalizeKeywords(source.skippedKeywords),
  });
}

function normalizeUnattendedCheckpointRound(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeUnattendedCheckpointIndex(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function buildUnattendedCheckpointResultKey(entry) {
  const round = normalizeUnattendedCheckpointRound(entry?.round);
  const keyword = String(entry?.keyword || '').trim();
  return keyword
    ? `${round}:keyword:${keyword}`
    : `${round}:index:${normalizeUnattendedCheckpointIndex(entry?.index)}`;
}

function collectUnattendedCheckpointResultKeys(checkpoint) {
  return new Set(
    (Array.isArray(checkpoint?.keywordResults)
      ? checkpoint.keywordResults
      : []
    ).map((entry) => buildUnattendedCheckpointResultKey(entry)),
  );
}

function normalizeUnattendedCheckpointResultStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isUnattendedCheckpointResultStatusRegression(currentStatus, nextStatus) {
  const current = normalizeUnattendedCheckpointResultStatus(currentStatus);
  const next = normalizeUnattendedCheckpointResultStatus(nextStatus);
  if (current === next) return false;
  if (!current) return false;
  const monotonicTransitions = {
    retrying: new Set(['partial', 'failed', 'completed']),
    partial: new Set(['failed', 'completed']),
    failed: new Set(['completed']),
  };
  return !monotonicTransitions[current]?.has(next);
}

function isUnattendedCheckpointResultRegression(nextEntry, currentEntry) {
  if (
    isUnattendedCheckpointResultStatusRegression(
      currentEntry?.status,
      nextEntry?.status,
    )
  ) {
    return true;
  }
  for (const field of ['index', 'attemptCount', 'savedCount']) {
    if (
      normalizeUnattendedCheckpointIndex(nextEntry?.[field]) <
      normalizeUnattendedCheckpointIndex(currentEntry?.[field])
    ) {
      return true;
    }
  }
  for (const field of [
    'noResults',
    'securityBlocked',
    'platformSafetyBlocked',
    'requiresManualAction',
  ]) {
    if (currentEntry?.[field] === true && nextEntry?.[field] !== true) {
      return true;
    }
  }
  return false;
}

function buildUnattendedCheckpointResultMap(checkpoint) {
  return new Map(
    (Array.isArray(checkpoint?.keywordResults)
      ? checkpoint.keywordResults
      : []
    ).map((entry) => [buildUnattendedCheckpointResultKey(entry), entry]),
  );
}

function collectUnattendedSettledCheckpointKeywords(checkpoint) {
  const keywords = new Set();
  for (const field of [
    'completedKeywords',
    'failedKeywords',
    'skippedKeywords',
  ]) {
    for (const value of Array.isArray(checkpoint?.[field])
      ? checkpoint[field]
      : []) {
      const keyword = String(value || '').trim();
      if (keyword) keywords.add(keyword);
    }
  }
  for (const entry of Array.isArray(checkpoint?.keywordResults)
    ? checkpoint.keywordResults
    : []) {
    const keyword = String(entry?.keyword || '').trim();
    const status = String(entry?.status || '').trim();
    if (keyword && UNATTENDED_SETTLED_CHECKPOINT_STATUSES.has(status)) {
      keywords.add(keyword);
    }
  }
  return keywords;
}

function collectUnattendedCheckpointSettlementStatuses(checkpoint) {
  const statuses = new Map();
  const add = (keywordValue, statusValue) => {
    const keyword = String(keywordValue || '').trim();
    const status = normalizeUnattendedCheckpointResultStatus(statusValue);
    if (!keyword || !status) return;
    const current = statuses.get(keyword) || new Set();
    current.add(status);
    statuses.set(keyword, current);
  };
  for (const [field, status] of [
    ['completedKeywords', 'completed'],
    ['failedKeywords', 'failed'],
    ['skippedKeywords', 'skipped'],
  ]) {
    for (const keyword of Array.isArray(checkpoint?.[field])
      ? checkpoint[field]
      : []) {
      add(keyword, status);
    }
  }
  for (const entry of Array.isArray(checkpoint?.keywordResults)
    ? checkpoint.keywordResults
    : []) {
    if (
      UNATTENDED_SETTLED_CHECKPOINT_STATUSES.has(
        normalizeUnattendedCheckpointResultStatus(entry?.status),
      )
    ) {
      add(entry?.keyword, entry?.status);
    }
  }
  return statuses;
}

function isUnattendedCheckpointSettlementRegression(
  nextCheckpoint,
  currentCheckpoint,
) {
  const nextStatuses = collectUnattendedCheckpointSettlementStatuses(
    nextCheckpoint,
  );
  for (const [keyword, currentStatuses] of
    collectUnattendedCheckpointSettlementStatuses(currentCheckpoint)) {
    const available = nextStatuses.get(keyword) || new Set();
    for (const status of currentStatuses) {
      const preserved = available.has(status);
      const upgraded =
        (status === 'failed' && available.has('completed')) ||
        (status === 'partial' &&
          (available.has('failed') || available.has('completed')));
      if (!preserved && !upgraded) return true;
    }
  }
  return false;
}

function isLegacyUnattendedCheckpointRegression(nextCheckpoint, currentCheckpoint) {
  const nextRound = normalizeUnattendedCheckpointRound(nextCheckpoint?.round);
  const currentRound = normalizeUnattendedCheckpointRound(
    currentCheckpoint?.round,
  );
  if (nextRound < currentRound) return true;
  if (nextRound === currentRound) {
    for (const field of ['keywordIndex', 'activeKeywordIndex']) {
      if (
        normalizeUnattendedCheckpointIndex(nextCheckpoint?.[field]) <
        normalizeUnattendedCheckpointIndex(currentCheckpoint?.[field])
      ) {
        return true;
      }
    }
  }

  const nextSettledKeywords = collectUnattendedSettledCheckpointKeywords(
    nextCheckpoint,
  );
  for (const keyword of collectUnattendedSettledCheckpointKeywords(
    currentCheckpoint,
  )) {
    if (!nextSettledKeywords.has(keyword)) return true;
  }
  if (
    isUnattendedCheckpointSettlementRegression(nextCheckpoint, currentCheckpoint)
  ) {
    return true;
  }

  const nextResults = buildUnattendedCheckpointResultMap(nextCheckpoint);
  for (const [resultKey, currentEntry] of
    buildUnattendedCheckpointResultMap(currentCheckpoint)) {
    const nextEntry = nextResults.get(resultKey);
    if (!nextEntry) return true;
    if (isUnattendedCheckpointResultRegression(nextEntry, currentEntry)) {
      return true;
    }
  }
  return false;
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
      noResults: entry?.noResults === true,
      resultKind: String(entry?.resultKind || '').trim(),
      candidateCount: Math.max(0, Number(entry?.candidateCount) || 0),
      scanComplete: entry?.scanComplete === true,
      error: String(entry?.error || '').trim(),
      errorCode: String(entry?.errorCode || '').trim(),
      errorCategory: String(entry?.errorCategory || '').trim(),
      securityBlocked: entry?.securityBlocked === true,
      requiresManualAction: entry?.requiresManualAction === true,
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
  const executionMode =
    String(normalized.executionMode || '').trim() === 'one_time'
      ? 'one_time'
      : 'unattended_plan';
  const orchestrationContext = normalizeOrchestrationExecutionContext(
    normalized.orchestrationContext,
  );
  return {
    ...(previousRun && typeof previousRun === 'object' ? previousRun : {}),
    id: normalized.id,
    taskType: 'unattended_keyword_capture',
    featureKey: 'unattended_keyword_plan',
    source: normalized.cloudAssigned === true
      ? 'cloud_assignment'
      : 'unattended_supervisor',
    status: String(normalized.status || 'pending'),
    platform: plan.platform,
    trigger: String(normalized.reason || 'schedule'),
    title:
      orchestrationContext
        ? '无人值守计划执行批次'
        : executionMode === 'one_time'
        ? '一次性关键词采集'
        : '无人值守关键词采集',
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
      cloudCommandId: String(normalized.cloudCommandId || ''),
      cloudAssigned: normalized.cloudAssigned === true,
      executionMode,
      cloudAgentScopeId: String(normalized.cloudAgentScopeId || ''),
      recoveryMode: String(normalized.recoveryMode || ''),
      attemptIdentity: String(orchestrationContext?.attemptIdentity || ''),
      ...(orchestrationContext ? {orchestrationContext} : {}),
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
  const normalized = normalizeUnattendedRunRequest(request);
  if (!normalized) {
    return {request: null, plan: null, ledger: null};
  }
  const persist = () => runTaskLedgerMutation(async () => {
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
    const shouldMirrorPlan = mirrorPlan && normalized.cloudAssigned !== true;
    if (ledgerResult.accepted === false) {
      if (
        ledgerResult.reason === 'terminal_absorbed' &&
        isTerminalUnattendedRunStatus(normalized.status)
      ) {
        const preservedRequest = normalizeUnattendedRunRequest({
          ...normalized,
          status: ledgerResult.run?.status || normalized.status,
          message: ledgerResult.run?.message || normalized.message,
          error: ledgerResult.run?.error || normalized.error,
          finishedAt:
            ledgerResult.run?.finishedAt ||
            normalized.finishedAt ||
            normalized.updatedAt,
          recoveryPendingLaunch: false,
          recoveryWaitUntil: '',
          wakeGraceUntil: '',
          progress: {
            ...(normalized.progress && typeof normalized.progress === 'object'
              ? normalized.progress
              : {}),
            phase: `unattended_${ledgerResult.run?.status || normalized.status}`,
            waitUntil: '',
            remainingMs: null,
          },
        });
        const preservedPlan = shouldMirrorPlan
          ? buildPlanMirrorForUnattendedRequest(
              plan,
              preservedRequest,
              now,
            )
          : plan;
        const terminalValues = {
          [STORAGE_KEYS.unattendedKeywordRunRequest]: preservedRequest,
          [STORAGE_KEYS.taskLedger]: ledgerResult.ledger,
        };
        if (shouldMirrorPlan) {
          terminalValues[STORAGE_KEYS.unattendedKeywordPlan] = preservedPlan;
        }
        await chrome.storage.local.set(terminalValues);
        scheduleCloudTaskAgentSync('unattended_terminal_reconciled');
        return {
          request: preservedRequest,
          plan: preservedPlan,
          ledger: ledgerResult.ledger,
          ledgerAccepted: false,
          ledgerReason: ledgerResult.reason,
          alreadyTerminal: true,
        };
      }
      const error = new Error(
        `task ledger rejected unattended mutation: ${ledgerResult.reason || 'unknown'}`,
      );
      error.code = 'UNATTENDED_LEDGER_REJECTED';
      throw error;
    }
    const nextPlan = shouldMirrorPlan
      ? buildPlanMirrorForUnattendedRequest(plan, normalized, now)
      : plan;
    const values = {
      [STORAGE_KEYS.unattendedKeywordRunRequest]: normalized,
      [STORAGE_KEYS.taskLedger]: ledgerResult.ledger,
    };
    if (shouldMirrorPlan) {
      values[STORAGE_KEYS.unattendedKeywordPlan] = nextPlan;
    }
    await chrome.storage.local.set(values);
    scheduleCloudTaskAgentSync('unattended_state_changed');
    return {
      request: normalized,
      plan: nextPlan,
      ledger: ledgerResult.ledger,
      ledgerAccepted: ledgerResult.accepted,
      ledgerReason: ledgerResult.reason,
    };
  });
  return isTerminalUnattendedRunStatus(normalized.status)
    ? await runAuthoritativeControlStorageMutation(persist)
    : await persist();
}

async function readTaskLedger() {
  return await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.taskLedger,
      STORAGE_KEYS.unattendedKeywordRunRequest,
      STORAGE_KEYS.targetedPostRunRequest,
    ]);
    const rawLedger = stored[STORAGE_KEYS.taskLedger];
    const core = getUnattendedTaskCenterCore();
    if (core?.normalizeTaskLedger) {
      const now = Date.now();
      let normalized = core.normalizeTaskLedger(rawLedger, {now});
      let repairedTargetedLedger = false;
      const targetedRequest = stored[STORAGE_KEYS.targetedPostRunRequest];
      const targetedRequestId = targetedPostPhysicalRunId(targetedRequest);
      if (
        targetedRequestId &&
        isSupportedCloudTargetedPostWorkflow(targetedRequest?.workflow) &&
        !normalized.runs.some((run) => run?.id === targetedRequestId)
      ) {
        const taskRun = buildTargetedPostTaskCenterRun(targetedRequest);
        if (taskRun) {
          if (!taskRun.metadata.cloudAgentScopeId) {
            taskRun.metadata.cloudAgentScopeId = String(
              (await readCloudTaskAgentCredential()).id || '',
            );
          }
          const result = core.upsertTaskRun(normalized, taskRun, {
            now,
            attemptId: String(taskRun.attemptId || ''),
          });
          if (result.accepted) {
            normalized = result.ledger;
            repairedTargetedLedger = true;
          }
        }
      }
      const reconciled = core.reconcileStaleTaskLedger
        ? core.reconcileStaleTaskLedger(normalized, {
            now,
            staleAfterMs: TASK_LEDGER_STALE_ACTIVE_MS,
            isTaskActive: (run) =>
              isTaskRunActuallyActive(run, {
                now,
                unattendedRequest:
                  stored[STORAGE_KEYS.unattendedKeywordRunRequest],
                targetedRequest:
                  stored[STORAGE_KEYS.targetedPostRunRequest],
              }),
          })
        : normalized;
      if (
        repairedTargetedLedger ||
        JSON.stringify(reconciled) !== JSON.stringify(normalized)
      ) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.taskLedger]: reconciled,
        });
      }
      return reconciled;
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

let cloudTaskAgentSyncInFlight = false;
let cloudTaskAgentLivenessInFlight = false;
let cloudTaskAgentSyncPending = false;
let cloudTaskAgentLastSyncAt = 0;
let cloudTaskAgentSyncTimer = null;
let cloudTaskAgentLastError = '';
let cloudTaskAgentFailureCount = 0;
let cloudTaskAgentRetryNotBefore = 0;
let socialAccountIdentityRefreshInFlight = null;
let socialAccountUsageQueueMutation = Promise.resolve();

function normalizeCloudTaskAgentError(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(authorization|cookie|password|secret|token|api[_-]?key|auth[_-]?code)\s*[:=]\s*[^\s,;&]+/gi,
      '$1=[REDACTED]',
    )
    .slice(0, 1000);
}

function recordCloudTaskAgentFailure() {
  cloudTaskAgentFailureCount += 1;
  const exponent = Math.max(0, Math.min(8, cloudTaskAgentFailureCount - 1));
  const delayMs = Math.min(
    CLOUD_TASK_AGENT_FAILURE_BACKOFF_MAX_MS,
    CLOUD_TASK_AGENT_FAILURE_BACKOFF_BASE_MS * (2 ** exponent),
  );
  cloudTaskAgentRetryNotBefore = Date.now() + delayMs;
  return delayMs;
}

function clearCloudTaskAgentFailureBackoff() {
  cloudTaskAgentFailureCount = 0;
  cloudTaskAgentRetryNotBefore = 0;
}

function normalizeCachedObservedSocialAccounts(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  const compatible = Number(source.schemaVersion) === 2;
  const now = Date.now();
  return {
    schemaVersion: 2,
    updatedAt: compatible ? String(source.updatedAt || '') : '',
    accounts: (
      compatible && Array.isArray(source.accounts)
        ? source.accounts
        : []
    )
      .filter(account =>
        ['xiaohongshu', 'douyin', 'weibo'].includes(
          String(account?.platform || ''),
        ),
      )
      .filter(account => {
        const observedAt = Date.parse(String(account?.observedAt || ''));
        return (
          Number.isFinite(observedAt) &&
          now - observedAt >= 0 &&
          now - observedAt <= SOCIAL_ACCOUNT_IDENTITY_CACHE_MAX_AGE_MS
        );
      })
      .slice(0, 10),
  };
}

async function readObservedSocialAccounts() {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.observedSocialAccounts,
  );
  return normalizeCachedObservedSocialAccounts(
    stored[STORAGE_KEYS.observedSocialAccounts],
  );
}

async function storeObservedSocialAccounts(accounts) {
  const next = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    accounts: (Array.isArray(accounts) ? accounts : []).slice(0, 10),
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.observedSocialAccounts]: next,
  });
  return next;
}

function observedSocialAccountPriority(account) {
  const loginScore =
    account?.loginState === 'authenticated'
      ? 300
      : account?.loginState === 'logged_out'
        ? 200
        : 100;
  const confidenceScore =
    account?.confidence === 'high'
      ? 30
      : account?.confidence === 'medium'
        ? 20
        : 10;
  return (
    loginScore +
    confidenceScore +
    (account?.platformAccountId ? 8 : 0) +
    (account?.accountHandle ? 4 : 0) +
    (account?.displayName ? 2 : 0)
  );
}

async function detectObservedSocialAccountInTab(tab, platform) {
  const tabId = Number(tab?.id);
  if (!Number.isFinite(tabId) || tabId <= 0 || !platform) return null;
  try {
    const response = await sendContentMessageWithTimeout(
      tabId,
      {action: 'detectLoggedSocialAccount'},
      5000,
    );
    const account =
      response?.ok === true &&
      response.data &&
      typeof response.data === 'object' &&
      !Array.isArray(response.data)
        ? response.data
        : null;
    return account?.platform === platform ? account : null;
  } catch {
    return null;
  }
}

async function mergeObservedSocialAccount(account) {
  if (!account?.platform) return await readObservedSocialAccounts();
  const cached = await readObservedSocialAccounts();
  const next = cached.accounts.filter(
    candidate => candidate?.platform !== account.platform,
  );
  next.push(account);
  return await storeObservedSocialAccounts(next);
}

async function refreshObservedSocialAccounts({force = false} = {}) {
  if (socialAccountIdentityRefreshInFlight) {
    return await socialAccountIdentityRefreshInFlight;
  }
  const cached = await readObservedSocialAccounts();
  const refreshedAt = Date.parse(cached.updatedAt);
  if (
    !force &&
    cached.accounts.length > 0 &&
    Number.isFinite(refreshedAt) &&
    Date.now() - refreshedAt < SOCIAL_ACCOUNT_IDENTITY_REFRESH_MS
  ) {
    return cached;
  }

  socialAccountIdentityRefreshInFlight = (async () => {
    const tabs = await chrome.tabs.query({});
    const relevantTabs = tabs
      .map(tab => ({tab, platform: detectPlatformFromUrl(tab?.url || '')}))
      .filter(item =>
        ['xiaohongshu', 'douyin', 'weibo'].includes(item.platform),
      );
    const detected = await Promise.all(
      relevantTabs.map(({tab, platform}) =>
        detectObservedSocialAccountInTab(tab, platform),
      ),
    );
    const bestDetectedByPlatform = new Map();
    for (const account of detected.filter(Boolean)) {
      const previous = bestDetectedByPlatform.get(account.platform);
      if (
        !previous ||
        observedSocialAccountPriority(account) >=
          observedSocialAccountPriority(previous)
      ) {
        bestDetectedByPlatform.set(account.platform, account);
      }
    }
    const activePlatforms = new Set(
      relevantTabs.map(item => item.platform),
    );
    const bestByPlatform = new Map(
      cached.accounts
        .filter(account => activePlatforms.has(account.platform))
        .map(account => [account.platform, account]),
    );
    for (const [platform, account] of bestDetectedByPlatform) {
      bestByPlatform.set(platform, account);
    }
    return await storeObservedSocialAccounts(
      Array.from(bestByPlatform.values()),
    );
  })();
  try {
    return await socialAccountIdentityRefreshInFlight;
  } finally {
    socialAccountIdentityRefreshInFlight = null;
  }
}

async function readSocialAccountUsageQueue() {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.socialAccountUsageQueue,
  );
  return socialAccountUsageApi?.normalizeUsageQueue
    ? socialAccountUsageApi.normalizeUsageQueue(
        stored[STORAGE_KEYS.socialAccountUsageQueue],
      )
    : [];
}

function mutateSocialAccountUsageQueue(mutator) {
  const mutation = socialAccountUsageQueueMutation
    .catch(() => null)
    .then(async () => {
      const current = await readSocialAccountUsageQueue();
      const next = mutator(current);
      await chrome.storage.local.set({
        [STORAGE_KEYS.socialAccountUsageQueue]: next,
      });
      return next;
    });
  socialAccountUsageQueueMutation = mutation.catch(() => null);
  return mutation;
}

async function appendSocialAccountUsageEvent(event) {
  if (!event || !socialAccountUsageApi?.appendUsageEvent) return [];
  return await mutateSocialAccountUsageQueue(current =>
    socialAccountUsageApi.appendUsageEvent(current, event),
  );
}

async function acknowledgeSocialAccountUsageEvents(eventIds) {
  if (!socialAccountUsageApi?.acknowledgeUsageEvents) return [];
  return await mutateSocialAccountUsageQueue(current =>
    socialAccountUsageApi.acknowledgeUsageEvents(current, eventIds),
  );
}

async function recordSocialAccountUsageFromRelay({
  tab,
  action,
  platform,
  response,
  error,
  sourcePayload,
}) {
  if (!socialAccountUsageApi?.buildUsageEventFromRelay) return null;
  const detected = await detectObservedSocialAccountInTab(tab, platform);
  if (detected) {
    await mergeObservedSocialAccount(detected);
  }
  const event = socialAccountUsageApi.buildUsageEventFromRelay({
    action,
    platform,
    response,
    error,
    taskId:
      sourcePayload?.taskId ||
      sourcePayload?.taskContext?.taskId ||
      sourcePayload?.captureRequestId,
    featureKey:
      sourcePayload?.featureKey ||
      sourcePayload?.taskContext?.featureKey,
    observedAccount: detected,
  });
  if (!event) return null;
  await appendSocialAccountUsageEvent(event);
  scheduleCloudTaskAgentSync('social_account_usage', 50);
  return event;
}

async function readCloudTaskAgentStatus() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cloudAgentStatus);
  const status = stored[STORAGE_KEYS.cloudAgentStatus];
  return status && typeof status === 'object' && !Array.isArray(status) ? status : {};
}

async function rememberCloudTaskAgentError(value) {
  cloudTaskAgentLastError = normalizeCloudTaskAgentError(value);
  const current = await readCloudTaskAgentStatus();
  await chrome.storage.local.set({
    [STORAGE_KEYS.cloudAgentStatus]: {
      ...current,
      lastError: cloudTaskAgentLastError,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function clearReportedCloudTaskAgentError(reportedError) {
  const expected = normalizeCloudTaskAgentError(reportedError);
  const current = await readCloudTaskAgentStatus();
  if (normalizeCloudTaskAgentError(current.lastError) !== expected) return;
  cloudTaskAgentLastError = '';
  await chrome.storage.local.set({
    [STORAGE_KEYS.cloudAgentStatus]: {
      ...current,
      lastError: '',
      updatedAt: new Date().toISOString(),
    },
  });
}

async function readCloudTaskAgentCredential() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.auth);
  const auth =
    stored[STORAGE_KEYS.auth] && typeof stored[STORAGE_KEYS.auth] === 'object'
      ? stored[STORAGE_KEYS.auth]
      : {};
  const captureAgent =
    auth.captureAgent && typeof auth.captureAgent === 'object'
      ? auth.captureAgent
      : {};
  return {
    id: String(captureAgent.id || '').trim(),
    token: String(captureAgent.token || '').trim(),
  };
}

async function ensureCloudTaskAgentScope(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  const current = await readCloudTaskAgentStatus();
  if (!normalizedAgentId || current.agentId === normalizedAgentId) {
    return current;
  }

  const switched = Boolean(String(current.agentId || '').trim());
  const now = new Date().toISOString();
  const next = {
    ...current,
    agentId: normalizedAgentId,
    // The first scope recorded after upgrading belongs to the already-active
    // node, so its existing local plan/history may be mirrored. A later node
    // identity change starts a strict boundary: only data created or explicitly
    // saved after this time can be sent to the new tenant/node.
    scopeStartedAt: switched ? now : '',
    planScopeAgentId: switched
      ? ''
      : String(current.planScopeAgentId || normalizedAgentId),
    lastError: switched ? '' : String(current.lastError || ''),
    updatedAt: now,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.cloudAgentStatus]: next,
  });
  if (switched) {
    cloudTaskAgentLastError = '';
    await runCloudCommandResultsMutation(() =>
      chrome.storage.local.remove(STORAGE_KEYS.cloudCommandResults));
    await clearUnattendedKeywordRunArchive();
  }
  return next;
}

async function confirmCloudTaskAgentPlanScope(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return;
  const current = await ensureCloudTaskAgentScope(normalizedAgentId);
  await chrome.storage.local.set({
    [STORAGE_KEYS.cloudAgentStatus]: {
      ...current,
      planScopeAgentId: normalizedAgentId,
      updatedAt: new Date().toISOString(),
    },
  });
}

function cloudScopeTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildCloudScopedTaskLedger(ledger, scopeStartedAt = '', agentId = '') {
  const scopeTimestamp = cloudScopeTimestamp(scopeStartedAt);
  if (!scopeTimestamp) return ledger;
  const normalizedAgentId = String(agentId || '').trim();
  const source = ledger && typeof ledger === 'object' ? ledger : {};
  const runs = Array.isArray(source.runs) ? source.runs : [];
  return {
    ...source,
    runs: runs.filter((run) => {
      const runAgentId = String(
        run?.metadata?.cloudAgentScopeId || run?.cloudAgentScopeId || '',
      ).trim();
      return Boolean(normalizedAgentId && runAgentId === normalizedAgentId);
    }),
  };
}

function buildCloudScopedUnattendedPlan(plan, agentStatus = {}, agentId = '') {
  const scopeStartedAt = agentStatus?.scopeStartedAt;
  const scopeTimestamp = cloudScopeTimestamp(scopeStartedAt);
  if (!scopeTimestamp) return plan;
  return String(agentStatus?.planScopeAgentId || '') === String(agentId || '')
    ? plan
    : null;
}

async function readCloudCommandResults() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cloudCommandResults);
  const raw = stored[STORAGE_KEYS.cloudCommandResults];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function rememberCloudCommandResult(commandId, result) {
  return await runCloudCommandResultsMutation(async () => {
    const current = await readCloudCommandResults();
    const entries = Object.entries({
      ...current,
      [commandId]: {
        ...(result && typeof result === 'object' ? result : {}),
        storedAt: new Date().toISOString(),
      },
    })
      .sort((left, right) =>
        Date.parse(String(right[1]?.storedAt || '')) -
        Date.parse(String(left[1]?.storedAt || '')),
      )
      .slice(0, 50);
    const next = Object.fromEntries(entries);
    await chrome.storage.local.set({[STORAGE_KEYS.cloudCommandResults]: next});
    return next[commandId];
  });
}

function summarizeCloudRecoveryResult(result) {
  return {
    state: 'completed',
    accepted: result?.accepted === true,
    reason: String(result?.reason || ''),
    requestId: String(result?.request?.id || result?.request?.requestId || ''),
    parentRequestId: String(result?.request?.parentRequestId || ''),
    message: String(
      result?.request?.message ||
        (result?.accepted ? '设备已创建恢复任务' : '设备无法恢复当前任务'),
    ).slice(0, 1000),
  };
}

function summarizeCloudCreationResult(request, commandId) {
  const requestId = String(request?.id || request?.requestId || '').trim();
  return {
    state: 'completed',
    accepted: Boolean(requestId),
    reason: requestId ? 'created' : 'create_failed',
    requestId,
    cloudCommandId: String(commandId || ''),
    message: requestId
      ? '设备已创建并启动云端下发任务'
      : '设备未能创建云端下发任务',
  };
}

function summarizeCloudPlanSaveResult(plan, commandId, requestId) {
  const normalizedRequestId = String(requestId || '').trim();
  return {
    state: 'completed',
    accepted: Boolean(normalizedRequestId && plan?.enabled),
    reason: normalizedRequestId && plan?.enabled ? 'plan_saved' : 'plan_save_failed',
    requestId: normalizedRequestId,
    cloudCommandId: String(commandId || ''),
    executionMode: 'unattended_plan',
    message: plan?.enabled
      ? '设备已保存并启用无人值守计划'
      : '设备未能启用无人值守计划',
  };
}

function summarizeCloudPlanDeleteResult(commandId, requestId) {
  const normalizedRequestId = String(requestId || '').trim();
  return {
    state: 'completed',
    accepted: Boolean(normalizedRequestId),
    reason: normalizedRequestId ? 'plan_deleted' : 'plan_delete_failed',
    requestId: normalizedRequestId,
    cloudCommandId: String(commandId || ''),
    executionMode: 'unattended_plan',
    planOperation: 'delete',
    message: normalizedRequestId
      ? '设备已停止并删除无人值守计划'
      : '设备未能删除无人值守计划',
  };
}

function isSupportedCloudTargetedPostWorkflow(value) {
  const workflow = String(value || '').trim();
  if (typeof cloudTargetedPostApi?.isSupportedWorkflow === 'function') {
    return cloudTargetedPostApi.isSupportedWorkflow(workflow);
  }
  return workflow === 'negative_post_patrol';
}

function resolveCloudTargetedPostWorkflow(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const plan =
    source.planSnapshot && typeof source.planSnapshot === 'object'
      ? source.planSnapshot
      : {};
  const workflow = String(source.workflow || plan.workflow || '').trim();
  return isSupportedCloudTargetedPostWorkflow(workflow) ? workflow : '';
}

function isCloudTargetedPostPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const plan =
    source.planSnapshot && typeof source.planSnapshot === 'object'
      ? source.planSnapshot
      : {};
  return isSupportedCloudTargetedPostWorkflow(
    String(source.workflow || plan.workflow || '').trim(),
  );
}

function resolveOfficialPatrolRunError(request = {}) {
  const source =
    request && typeof request === 'object' && !Array.isArray(request)
      ? request
      : {};
  const rootError =
    source.error &&
    typeof source.error === 'object' &&
    !Array.isArray(source.error)
      ? source.error
      : null;
  if (rootError && Object.keys(rootError).length > 0) return rootError;
  if (
    String(source.workflow || '').trim() !==
    'official_account_comment_patrol'
  ) {
    return rootError;
  }
  if (
    ![
      'completed_with_warnings',
      'failed',
      'canceled',
      'needs_action',
    ].includes(String(source.status || '').trim())
  ) {
    return null;
  }

  const results = Array.isArray(source.targetResults)
    ? source.targetResults
    : [];
  const statusPriority = new Map([
    ['failed', 0],
    ['completed_with_warnings', 1],
    ['canceled', 2],
  ]);
  const representative = results
    .filter((result) => {
      const error = result?.error;
      return Boolean(
        error &&
          typeof error === 'object' &&
          !Array.isArray(error) &&
          (String(error.code || error.reason || '').trim() ||
            String(error.message || '').trim()),
      );
    })
    .sort((left, right) => {
      const leftPriority =
        statusPriority.get(String(left?.status || '').trim()) ?? 3;
      const rightPriority =
        statusPriority.get(String(right?.status || '').trim()) ?? 3;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      return (Number(left?.ordinal) || 0) - (Number(right?.ordinal) || 0);
    })[0];
  return representative?.error || null;
}

function normalizeStoredTargetedPostRunRequest(request) {
  if (
    !request ||
    typeof request !== 'object' ||
    !isSupportedCloudTargetedPostWorkflow(request.workflow)
  ) {
    return {request: null, changed: false};
  }
  const targets = Array.isArray(request.targets) ? request.targets : [];
  if (
    targets.length === 0 ||
    typeof cloudTargetedPostApi?.normalizeTargetResults !== 'function'
  ) {
    return {request, changed: false};
  }
  const targetResults = cloudTargetedPostApi.normalizeTargetResults(
    request.targetResults,
    targets,
  );
  const checkpoint =
    typeof cloudTargetedPostApi?.buildCheckpoint === 'function'
      ? {
          ...(request.checkpoint && typeof request.checkpoint === 'object'
            ? request.checkpoint
            : {}),
          ...cloudTargetedPostApi.buildCheckpoint(targets, targetResults),
        }
      : request.checkpoint;
  const normalized = {
    ...request,
    targetResults,
    checkpoint,
  };
  const resolvedError = resolveOfficialPatrolRunError(normalized);
  if (resolvedError) normalized.error = resolvedError;
  return {
    request: normalized,
    changed:
      JSON.stringify(targetResults) !== JSON.stringify(request.targetResults) ||
      JSON.stringify(checkpoint) !== JSON.stringify(request.checkpoint) ||
      JSON.stringify(resolvedError) !== JSON.stringify(request.error || null),
  };
}

async function readTargetedPostRunRequest({persistNormalized = true} = {}) {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.targetedPostRunRequest,
  );
  const normalized = normalizeStoredTargetedPostRunRequest(
    stored[STORAGE_KEYS.targetedPostRunRequest],
  );
  if (
    !normalized.request ||
    !normalized.changed ||
    !persistNormalized
  ) {
    return normalized.request;
  }
  const expectedAttempt = normalized.request;
  return await runTargetedPostRunMutation(async () => {
    const latestStored = await chrome.storage.local.get(
      STORAGE_KEYS.targetedPostRunRequest,
    );
    const latest = normalizeStoredTargetedPostRunRequest(
      latestStored[STORAGE_KEYS.targetedPostRunRequest],
    );
    if (!latest.request) return null;
    if (!isOwnedTargetedPostAttempt(latest.request, expectedAttempt)) {
      return latest.request;
    }
    if (latest.changed) {
      await persistTargetedPostRunRequest(latest.request);
    }
    return latest.request;
  });
}

function targetedPostTaskCenterDescriptor(request = {}) {
  const workflow = String(request?.workflow || '').trim();
  if (workflow === 'watched_content_patrol') {
    return {
      workflow,
      taskType: 'watched_content_patrol',
      title: String(request?.title || '').trim() || '关注内容巡查',
    };
  }
  if (workflow === 'official_account_comment_patrol') {
    return {
      workflow,
      taskType: 'official_account_comment_patrol',
      title: String(request?.title || '').trim() || '官方账号评论巡查',
    };
  }
  if (workflow === 'followed_creator_post_patrol') {
    return {
      workflow,
      taskType: 'followed_creator_post_patrol',
      title: String(request?.title || '').trim() || '关注博主作品扫描',
    };
  }
  if (workflow === 'official_account_post_discovery') {
    return {
      workflow,
      taskType: 'official_account_post_discovery',
      title: String(request?.title || '').trim() || '官方账号作品发现',
    };
  }
  return {
    workflow: 'negative_post_patrol',
    taskType: 'negative_post_patrol',
    title: String(request?.title || '').trim() || '负面帖子定向巡查',
  };
}

function targetedPostTaskCenterStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'pending') return 'pending';
  if (status === 'running' || status === 'cancel_requested') return 'running';
  if (status === 'needs_action') return 'needs_action';
  if (
    [
      'completed',
      'completed_with_warnings',
      'completed_with_failures',
      'failed',
      'canceled',
      'skipped',
    ].includes(status)
  ) {
    return status;
  }
  return 'pending';
}

function targetedPostTaskCenterInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(0, Math.floor(numeric))
    : Math.max(0, Math.floor(Number(fallback) || 0));
}

function stableTargetedPostValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableTargetedPostValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) {
          result[key] = stableTargetedPostValue(value[key]);
        }
        return result;
      }, {});
  }
  return value;
}

function targetedPostExecutionContract(source) {
  const request =
    source && typeof source === 'object' && !Array.isArray(source)
      ? source
      : {};
  return {
    protocolVersion: targetedPostTaskCenterInteger(request.protocolVersion),
    workflow: String(request.workflow || ''),
    taskId: String(request.taskId || ''),
    fenceToken: String(request.fenceToken || ''),
    platform: String(request.platform || ''),
    title: String(request.title || ''),
    targetMode: String(request.targetMode || ''),
    profileMode: request.profileMode === true,
    subjectType: String(request.subjectType || ''),
    targets: Array.isArray(request.targets) ? request.targets : [],
    monitorSettings:
      request.monitorSettings &&
      typeof request.monitorSettings === 'object' &&
      !Array.isArray(request.monitorSettings)
        ? request.monitorSettings
        : {},
    captureSettings:
      request.captureSettings &&
      typeof request.captureSettings === 'object' &&
      !Array.isArray(request.captureSettings)
        ? request.captureSettings
        : {},
  };
}

function targetedPostExecutionFingerprint(source) {
  return JSON.stringify(
    stableTargetedPostValue(targetedPostExecutionContract(source)),
  );
}

function targetedPostLogicalRequestId(request = {}) {
  return String(request?.id || request?.requestId || '').trim();
}

function targetedPostPhysicalRunId(request = {}) {
  const requestId = targetedPostLogicalRequestId(request);
  const attemptId = String(request?.attemptId || '').trim();
  return requestId && attemptId ? `${requestId}::${attemptId}` : requestId;
}

async function inspectTargetedPostCaptureTaskAttempt({
  taskId = '',
  attemptId = '',
} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const incomingAttemptId = String(attemptId || '').trim();
  if (!normalizedTaskId) {
    return {targeted: false, current: false, request: null};
  }
  const request = await readTargetedPostRunRequest({
    persistNormalized: false,
  });
  const currentTaskId = targetedPostPhysicalRunId(request);
  const currentAttemptId = String(request?.attemptId || '').trim();
  const current = Boolean(
    request &&
      currentTaskId === normalizedTaskId &&
      (!incomingAttemptId || incomingAttemptId === currentAttemptId),
  );
  return {
    targeted: Boolean(request && currentTaskId === normalizedTaskId),
    current,
    request: current ? request : null,
  };
}

function isSameTargetedPostAttempt(
  left,
  right,
  {requireCommand = false} = {},
) {
  const same =
    targetedPostLogicalRequestId(left) &&
    targetedPostLogicalRequestId(left) === targetedPostLogicalRequestId(right) &&
    String(left?.attemptId || '').trim() &&
    String(left?.attemptId || '').trim() ===
      String(right?.attemptId || '').trim();
  if (!same || !requireCommand) return Boolean(same);
  const commandId = String(left?.cloudCommandId || '').trim();
  return Boolean(
    commandId && commandId === String(right?.cloudCommandId || '').trim(),
  );
}

function isOwnedTargetedPostAttempt(current, expected) {
  const expectedCommandId = String(expected?.cloudCommandId || '').trim();
  return isSameTargetedPostAttempt(current, expected, {
    requireCommand: Boolean(expectedCommandId),
  });
}

async function readOwnedTargetedPostAttempt(expected) {
  const current = await readTargetedPostRunRequest({
    persistNormalized: false,
  });
  return isOwnedTargetedPostAttempt(current, expected) ? current : null;
}

function isTargetedPostOwnerSnapshot(current, expected) {
  if (!expected) return !current;
  return isOwnedTargetedPostAttempt(current, expected);
}

function isTargetedPostRunnerTabForAttempt(tab, request) {
  const requestId = targetedPostLogicalRequestId(request);
  const attemptId = String(request?.attemptId || '').trim();
  if (!requestId || !attemptId) return false;
  try {
    const candidate = new URL(String(tab?.url || ''));
    const sidebar = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
    return (
      candidate.origin === sidebar.origin &&
      candidate.pathname === sidebar.pathname &&
      candidate.searchParams.get(TARGETED_POST_RUNNER_QUERY_KEY) ===
        requestId &&
      candidate.searchParams.get(TARGETED_POST_RUNNER_ATTEMPT_QUERY_KEY) ===
        attemptId
    );
  } catch (_error) {
    return false;
  }
}

async function closeSupersededTargetedPostRunnerTabs(
  superseded,
  expectedCurrent = null,
) {
  if (
    !targetedPostLogicalRequestId(superseded) ||
    !String(superseded?.attemptId || '').trim() ||
    isSameTargetedPostAttempt(superseded, expectedCurrent)
  ) {
    return {
      ok: true,
      current: await readTargetedPostRunRequest({persistNormalized: false}),
      removedTabIds: [],
      removedCount: 0,
    };
  }
  return await closeOwnedTargetedPostRunnerTabs(
    superseded,
    expectedCurrent,
  );
}

async function closeOwnedTargetedPostRunnerTabs(target, expectedCurrent) {
  let current = await readTargetedPostRunRequest({
    persistNormalized: false,
  });
  const initialResult = {
    ok: true,
    current,
    removedTabIds: [],
    removedCount: 0,
  };
  if (
    !targetedPostLogicalRequestId(target) ||
    !String(target?.attemptId || '').trim()
  ) {
    return initialResult;
  }
  if (!isTargetedPostOwnerSnapshot(current, expectedCurrent)) {
    return {...initialResult, ok: false};
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    return {
      ...initialResult,
      warning: String(error?.message || error || '').slice(0, 500),
    };
  }
  const candidates = tabs.filter((tab) =>
    isTargetedPostRunnerTabForAttempt(tab, target),
  );
  const removedTabIds = [];
  for (const tab of candidates) {
    current = await readTargetedPostRunRequest({
      persistNormalized: false,
    });
    if (!isTargetedPostOwnerSnapshot(current, expectedCurrent)) {
      return {
        ok: false,
        current,
        removedTabIds,
        removedCount: removedTabIds.length,
      };
    }
    const tabId = Number(tab?.id);
    if (!Number.isSafeInteger(tabId)) continue;
    try {
      await chrome.tabs.remove(tabId);
      removedTabIds.push(tabId);
    } catch (_error) {
      // 页面可能已由用户关闭；不影响新的执行轮次继续领取。
    }
  }
  return {
    ok: true,
    current,
    removedTabIds,
    removedCount: removedTabIds.length,
  };
}

async function closeTerminalTargetedPostRunnerTabs(request) {
  const status = String(request?.status || '').trim().toLowerCase();
  if (
    status === 'needs_action' ||
    !cloudTargetedPostApi?.isTerminalRunStatus?.(status)
  ) {
    return {
      ok: true,
      current: await readTargetedPostRunRequest({persistNormalized: false}),
      removedTabIds: [],
      removedCount: 0,
      skipped: true,
      reason:
        status === 'needs_action'
          ? 'targeted_post_needs_action_preserved'
          : 'targeted_post_not_terminal',
    };
  }
  return await closeOwnedTargetedPostRunnerTabs(request, request);
}

function buildTargetedPostTaskCenterRun(request, existingRun = null) {
  if (!request || typeof request !== 'object') return null;
  const logicalRequestId = targetedPostLogicalRequestId(request);
  const id = targetedPostPhysicalRunId(request);
  if (!id) return null;
  const descriptor = targetedPostTaskCenterDescriptor(request);
  const checkpoint =
    request.checkpoint &&
    typeof request.checkpoint === 'object' &&
    !Array.isArray(request.checkpoint)
      ? request.checkpoint
      : {};
  const progress =
    request.progress &&
    typeof request.progress === 'object' &&
    !Array.isArray(request.progress)
      ? request.progress
      : {};
  const targets = Array.isArray(request.targets) ? request.targets : [];
  const targetResults = Array.isArray(request.targetResults)
    ? request.targetResults
    : [];
  const total = targetedPostTaskCenterInteger(
    checkpoint.total,
    targetedPostTaskCenterInteger(progress.total, targets.length),
  );
  const processed = targetedPostTaskCenterInteger(
    checkpoint.processedCount,
    targetedPostTaskCenterInteger(progress.current, targetResults.length),
  );
  const updatedAt = String(
    request.updatedAt ||
      progress.updatedAt ||
      request.heartbeatAt ||
      request.startedAt ||
      request.createdAt ||
      new Date().toISOString(),
  );
  const status = targetedPostTaskCenterStatus(request.status);
  const terminal = Boolean(
    getUnattendedTaskCenterCore()?.isTerminalTaskStatus?.(status),
  );
  const priorMetadata =
    existingRun?.metadata &&
    typeof existingRun.metadata === 'object' &&
    !Array.isArray(existingRun.metadata)
      ? existingRun.metadata
      : {};
  const requestMetadata =
    request.metadata &&
    typeof request.metadata === 'object' &&
    !Array.isArray(request.metadata)
      ? request.metadata
      : {};
  return {
    id,
    taskType: descriptor.taskType,
    featureKey: descriptor.taskType,
    title: descriptor.title,
    source: 'cloud_assignment',
    trigger: 'remote',
    platform: String(request.platform || 'unknown').trim().toLowerCase(),
    status,
    attemptId: String(request.attemptId || ''),
    attemptNumber: targetedPostTaskCenterInteger(request.attemptNumber, 1),
    progressSeq: targetedPostTaskCenterInteger(request.progressSeq),
    createdAt: String(request.createdAt || updatedAt),
    startedAt: String(request.startedAt || ''),
    updatedAt,
    finishedAt: terminal ? String(request.finishedAt || updatedAt) : '',
    heartbeatAt: String(request.heartbeatAt || updatedAt),
    businessProgressAt: String(
      request.businessProgressAt ||
        request.startedAt ||
        request.createdAt ||
        updatedAt,
    ),
    message:
      String(progress.message || request.message || '').trim() ||
      (request.cancelRequested === true ? '正在停止定向巡查任务' : ''),
    error: resolveOfficialPatrolRunError(request),
    runnerTabId: request.runnerTabId,
    counts: {
      total,
      processed,
      saved: targetedPostTaskCenterInteger(checkpoint.capturedCount),
      success: targetedPostTaskCenterInteger(checkpoint.successCount),
      failed: targetedPostTaskCenterInteger(checkpoint.failedCount),
      skipped: targetedPostTaskCenterInteger(checkpoint.skippedCount),
      retried: targetedPostTaskCenterInteger(
        request.counts?.retried,
        request.retryCount,
      ),
      warnings: targetedPostTaskCenterInteger(checkpoint.warningCount),
    },
    progress: {
      current: targetedPostTaskCenterInteger(progress.current, processed),
      total: targetedPostTaskCenterInteger(progress.total, total),
      index: targetedPostTaskCenterInteger(progress.index, processed),
      phase: String(progress.phase || descriptor.workflow),
      message: String(progress.message || request.message || ''),
      retryCount: targetedPostTaskCenterInteger(progress.retryCount),
      maxRetries: targetedPostTaskCenterInteger(progress.maxRetries),
      updatedAt: String(progress.updatedAt || updatedAt),
    },
    metadata: {
      workflow: descriptor.workflow,
      logicalRequestId,
      protocolVersion: targetedPostTaskCenterInteger(request.protocolVersion),
      taskId: String(request.taskId || ''),
      cloudCommandId: String(request.cloudCommandId || ''),
      attemptId: String(request.attemptId || ''),
      previousAttemptId: String(request.previousAttemptId || ''),
      subjectType: String(request.subjectType || ''),
      targetMode: String(request.targetMode || ''),
      profileMode: request.profileMode === true,
      executionFingerprint: String(request.executionFingerprint || ''),
      targetCount: total,
      cancelRequested:
        request.cancelRequested === true ||
        String(request.status || '') === 'cancel_requested',
      cloudAgentScopeId: String(
        priorMetadata.cloudAgentScopeId ||
          requestMetadata.cloudAgentScopeId ||
          '',
      ),
    },
  };
}

async function persistTargetedPostRunRequest(request) {
  if (!request || typeof request !== 'object') {
    await chrome.storage.local.remove(STORAGE_KEYS.targetedPostRunRequest);
    return null;
  }
  const normalized = normalizeStoredTargetedPostRunRequest(request);
  const requestToPersist = normalized.request || request;
  const persist = () => runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.taskLedger);
    const core = getUnattendedTaskCenterCore();
    const now = new Date().toISOString();
    let ledger = core?.normalizeTaskLedger
      ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
      : stored[STORAGE_KEYS.taskLedger] || {
          version: 1,
          runs: [],
          updatedAt: '',
        };
    const existingRun = Array.isArray(ledger?.runs)
      ? ledger.runs.find(
          (item) => item?.id === targetedPostPhysicalRunId(requestToPersist),
        ) || null
      : null;
    const taskRun = buildTargetedPostTaskCenterRun(
      requestToPersist,
      existingRun,
    );
    if (!taskRun) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.targetedPostRunRequest]: requestToPersist,
      });
      return requestToPersist;
    }
    if (!taskRun.metadata.cloudAgentScopeId) {
      taskRun.metadata.cloudAgentScopeId = String(
        (await readCloudTaskAgentCredential()).id || '',
      );
    }
    const result = core?.upsertTaskRun
      ? core.upsertTaskRun(ledger, taskRun, {
          now,
          attemptId: String(taskRun.attemptId || ''),
        })
      : fallbackUpsertUnattendedTaskRun(ledger, taskRun, {
          previousAttemptId: String(taskRun.attemptId || ''),
        });
    if (result.accepted) {
      ledger = result.ledger;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.targetedPostRunRequest]: requestToPersist,
      [STORAGE_KEYS.taskLedger]: ledger,
    });
    scheduleCloudTaskAgentSync('targeted_post_state_changed');
    return requestToPersist;
  });
  return cloudTargetedPostApi?.isTerminalRunStatus?.(
    String(requestToPersist.status || ''),
  )
    ? await runAuthoritativeControlStorageMutation(persist)
    : await persist();
}

async function createOrResumeTargetedPostRun(command, payload) {
  if (!cloudTargetedPostApi?.normalizeCommandPayload) {
    const error = new Error('当前扩展缺少定向作品采集协议');
    error.code = 'TARGET_PROTOCOL_UNAVAILABLE';
    throw error;
  }
  const commandId = String(command?.id || '').trim();
  const normalized = cloudTargetedPostApi.normalizeCommandPayload(payload, {
    taskId: command?.task_id || command?.client_task_id,
    clientTaskId: command?.client_task_id,
  });
  const requestId = String(
    normalized.clientTaskId || normalized.taskId,
  ).trim();
  const executionFingerprint = targetedPostExecutionFingerprint(normalized);
  return await runTargetedPostRunMutation(async () => {
    const current = await readTargetedPostRunRequest({
      persistNormalized: false,
    });
    const sameRequest = Boolean(current && current.id === requestId);
    const sameCommand = Boolean(
      sameRequest &&
        commandId &&
        String(current.cloudCommandId || '') === commandId,
    );
    const currentFingerprint = current
      ? String(
          current.executionFingerprint ||
            targetedPostExecutionFingerprint(current),
        )
      : '';
    const exactDuplicate = Boolean(
      sameCommand &&
        current?.attemptId &&
        currentFingerprint === executionFingerprint,
    );

    if (exactDuplicate) {
      if (
        !cloudTargetedPostApi.isTerminalRunStatus(current.status) &&
        current.status === 'pending'
      ) {
        try {
          const ownedBeforeOpen = await readOwnedTargetedPostAttempt(current);
          if (!ownedBeforeOpen) {
            return await readTargetedPostRunRequest({
              persistNormalized: false,
            });
          }
          const runner = await openTargetedPostRunnerTab(current.id, {
            attemptId: current.attemptId,
          });
          const ownedAfterOpen = await readOwnedTargetedPostAttempt(current);
          if (!ownedAfterOpen) {
            await closeSupersededTargetedPostRunnerTabs(
              current,
              await readTargetedPostRunRequest({persistNormalized: false}),
            );
            return await readTargetedPostRunRequest({
              persistNormalized: false,
            });
          }
          if (runner?.id && Number(current.runnerTabId) !== Number(runner.id)) {
            const rebound = cloudTargetedPostApi.mergeRunPatch(current, {
              runnerTabId: runner.id,
              message: '定向作品任务运行页已连接',
            });
            return await persistTargetedPostRunRequest(rebound);
          }
        } catch (error) {
          const owned = await readOwnedTargetedPostAttempt(current);
          if (!owned) {
            return await readTargetedPostRunRequest({
              persistNormalized: false,
            });
          }
          const failed = cloudTargetedPostApi.mergeRunPatch(current, {
            status: 'needs_action',
            finishedAt: new Date().toISOString(),
            message: '无法打开定向作品采集运行页',
            error: {
              code: String(error?.code || 'TARGET_RUNNER_OPEN_FAILED'),
              message: String(error?.message || '无法打开采集运行页').slice(
                0,
                1000,
              ),
            },
          });
          return await persistTargetedPostRunRequest(failed);
        }
      }
      return current;
    }

    if (
      current &&
      !sameRequest &&
      !cloudTargetedPostApi.isTerminalRunStatus(current.status)
    ) {
      return {deferred: true, reason: 'targeted_post_task_busy'};
    }
    if (!sameRequest) {
      const activeLock = await readActiveCaptureExecutionLock();
      if (activeLock) {
        return {deferred: true, reason: 'capture_lock_busy'};
      }
    }

    const previousAttemptId = sameRequest
      ? String(current?.attemptId || '')
      : '';
    const attemptNumber = sameRequest
      ? Math.max(1, Number(current?.attemptNumber) || 1) + 1
      : 1;
    const nextAttemptId = createUuid();
    let supersededRequest = null;
    if (
      sameRequest &&
      current &&
      !cloudTargetedPostApi.isTerminalRunStatus(current.status)
    ) {
      const superseded = cloudTargetedPostApi.mergeRunPatch(current, {
        status: 'canceled',
        cancelRequested: true,
        finishedAt: new Date().toISOString(),
        message: '任务已由新的执行轮次接管',
        supersededByAttemptId: nextAttemptId,
      });
      await persistTargetedPostRunRequest(superseded);
      supersededRequest = superseded;
    }
    let request = cloudTargetedPostApi.createRunRequest(normalized, {
      commandId,
      requestId,
      attemptId: nextAttemptId,
      attemptNumber,
      previousAttemptId,
    });
    request = {
      ...request,
      executionFingerprint,
    };
    await persistTargetedPostRunRequest(request);
    if (supersededRequest) {
      const closed = await closeSupersededTargetedPostRunnerTabs(
        supersededRequest,
        request,
      );
      if (!closed.ok) {
        return (
          closed.current ||
          (await readTargetedPostRunRequest({persistNormalized: false}))
        );
      }
    }
    try {
      const ownedBeforeOpen = await readOwnedTargetedPostAttempt(request);
      if (!ownedBeforeOpen) {
        return await readTargetedPostRunRequest({
          persistNormalized: false,
        });
      }
      const runner = await openTargetedPostRunnerTab(request.id, {
        attemptId: request.attemptId,
      });
      const ownedAfterOpen = await readOwnedTargetedPostAttempt(request);
      if (!ownedAfterOpen) {
        await closeSupersededTargetedPostRunnerTabs(
          request,
          await readTargetedPostRunRequest({persistNormalized: false}),
        );
        return await readTargetedPostRunRequest({
          persistNormalized: false,
        });
      }
      request = cloudTargetedPostApi.mergeRunPatch(request, {
        runnerTabId: runner?.id,
        message: '定向作品任务已下发，等待运行页执行',
      });
      return await persistTargetedPostRunRequest(request);
    } catch (error) {
      const owned = await readOwnedTargetedPostAttempt(request);
      if (!owned) {
        return await readTargetedPostRunRequest({
          persistNormalized: false,
        });
      }
      const failed = cloudTargetedPostApi.mergeRunPatch(request, {
        status: 'needs_action',
        finishedAt: new Date().toISOString(),
        message: '无法打开定向作品采集运行页',
        error: {
          code: String(error?.code || 'TARGET_RUNNER_OPEN_FAILED'),
          message: String(error?.message || '无法打开采集运行页').slice(
            0,
            1000,
          ),
        },
      });
      await persistTargetedPostRunRequest(failed);
      return failed;
    }
  });
}

function summarizeTargetedPostRunForCloud(request, commandId) {
  const status = String(request?.status || '').trim();
  const accepted = ['completed', 'completed_with_warnings'].includes(status);
  return {
    state: 'completed',
    accepted,
    reason:
      status === 'completed'
        ? 'targeted_post_capture_completed'
        : status === 'completed_with_warnings'
          ? 'targeted_post_capture_partial'
          : status === 'canceled'
            ? 'targeted_post_capture_canceled'
            : 'targeted_post_capture_failed',
    requestId: String(request?.id || ''),
    taskId: String(request?.taskId || ''),
    attemptId: String(request?.attemptId || ''),
    protocolVersion: 1,
    workflow: String(request?.workflow || 'negative_post_patrol'),
    status,
    cloudCommandId: String(commandId || ''),
    targetResults: Array.isArray(request?.targetResults)
      ? request.targetResults
      : [],
    checkpoint:
      request?.checkpoint && typeof request.checkpoint === 'object'
        ? request.checkpoint
        : {},
    message: String(request?.message || '').slice(0, 1000),
    error: resolveOfficialPatrolRunError(request),
  };
}

async function reportTargetedPostTerminalToCloud(request) {
  if (
    !request ||
    !cloudTargetedPostApi?.isTerminalRunStatus?.(request.status)
  ) {
    return {ok: false, skipped: true, reason: 'targeted_post_not_terminal'};
  }
  return await runTargetedPostRunMutation(async () => {
    const current = await readTargetedPostRunRequest({
      persistNormalized: false,
    });
    if (!isSameTargetedPostAttempt(current, request, {requireCommand: true})) {
      return {
        ok: false,
        skipped: true,
        reason: 'stale_targeted_post_attempt',
      };
    }
    const commandId = String(current.cloudCommandId || '').trim();
    if (!commandId || !cloudTaskAgentApi?.completeCommand) {
      scheduleCloudTaskAgentSync('targeted_post_terminal_fallback', 0);
      return {
        ok: false,
        skipped: true,
        reason: commandId ? 'cloud_agent_unavailable' : 'missing_command_id',
      };
    }
    const credential = await readCloudTaskAgentCredential();
    if (!credential.token) {
      scheduleCloudTaskAgentSync('targeted_post_terminal_missing_credential', 0);
      return {ok: false, skipped: true, reason: 'missing_agent_credential'};
    }

    const result = await rememberCloudCommandResult(
      commandId,
      summarizeTargetedPostRunForCloud(current, commandId),
    );
    try {
      const response = await cloudTaskAgentApi.completeCommand({
        token: credential.token,
        commandId,
        success: result.accepted === true,
        result,
      });
      if (response?.ok) {
        clearCloudTaskAgentFailureBackoff();
        scheduleCloudTaskAgentSync('targeted_post_terminal_confirmed', 0);
        return response;
      }
      const retryDelay = recordCloudTaskAgentFailure();
      await rememberCloudTaskAgentError(
        response?.message || response?.reason || '定向作品任务终态回传失败',
      );
      scheduleCloudTaskAgentSync('targeted_post_terminal_retry', retryDelay);
      return response || {
        ok: false,
        reason: 'targeted_post_terminal_report_failed',
      };
    } catch (error) {
      const retryDelay = recordCloudTaskAgentFailure();
      await rememberCloudTaskAgentError(
        error?.message || '定向作品任务终态回传失败',
      );
      scheduleCloudTaskAgentSync('targeted_post_terminal_retry', retryDelay);
      return {
        ok: false,
        reason: 'targeted_post_terminal_report_failed',
        message: normalizeCloudTaskAgentError(error?.message || error),
      };
    }
  });
}

async function executeCloudTargetedPostCreateCommand(
  command,
  payload,
  commandResult,
) {
  const commandId = String(command?.id || '').trim();
  if (commandResult?.state === 'completed') {
    return {commandResult};
  }
  let request;
  try {
    request = await createOrResumeTargetedPostRun(command, payload);
  } catch (error) {
    return {
      commandResult: await rememberCloudCommandResult(commandId, {
        state: 'completed',
        accepted: false,
        reason: String(error?.code || 'invalid_targeted_post_payload'),
        requestId: String(payload?.clientTaskId || command?.client_task_id || ''),
        protocolVersion: 1,
        workflow: resolveCloudTargetedPostWorkflow(payload) || 'negative_post_patrol',
        message: String(error?.message || '定向作品任务参数无效').slice(0, 1000),
      }),
    };
  }
  if (request?.deferred) {
    return {
      deferred: true,
      reason: request.reason || 'targeted_post_task_busy',
    };
  }
  if (!cloudTargetedPostApi.isTerminalRunStatus(request?.status)) {
    await rememberCloudCommandResult(commandId, {
      state: 'executing',
      accepted: false,
      reason: 'executing',
      requestId: String(request?.id || ''),
      taskId: String(request?.taskId || ''),
      attemptId: String(request?.attemptId || ''),
      protocolVersion: 1,
      workflow: String(request?.workflow || 'negative_post_patrol'),
    });
    return {deferred: true, reason: 'targeted_post_running'};
  }
  return {
    commandResult: await rememberCloudCommandResult(
      commandId,
      summarizeTargetedPostRunForCloud(request, commandId),
    ),
  };
}

async function cancelTargetedPostRunFromControl(requestId, attemptId = '') {
  return await runTargetedPostRunMutation(async () => {
    const request = await readTargetedPostRunRequest({
      persistNormalized: false,
    });
    if (!request || (requestId && request.id !== requestId)) {
      return {
        matched: false,
        accepted: false,
        reason: 'not_found',
        request: null,
      };
    }
    if (!attemptId) {
      return {
        matched: true,
        accepted: false,
        reason: 'targeted_post_attempt_required',
        request,
      };
    }
    if (String(request.attemptId || '') !== String(attemptId).trim()) {
      return {
        matched: true,
        accepted: false,
        reason: 'stale_targeted_post_attempt',
        request,
      };
    }
    if (cloudTargetedPostApi.isTerminalRunStatus(request.status)) {
      return {
        matched: true,
        accepted: true,
        reason: 'already_terminal',
        request,
      };
    }
    const pending = String(request.status || '') === 'pending';
    const next = cloudTargetedPostApi.mergeRunPatch(request, {
      status: pending ? 'canceled' : 'cancel_requested',
      cancelRequested: true,
      finishedAt: pending ? new Date().toISOString() : '',
      message: pending
        ? '定向作品任务已在执行前停止'
        : '后台已请求停止定向作品任务，正在保留已有结果',
    });
    await persistTargetedPostRunRequest(next);
    return {
      matched: true,
      accepted: true,
      reason: pending ? 'stopped_before_dispatch' : 'cancel_requested',
      request: next,
    };
  });
}

async function executeCloudTaskAgentCommand(command, token) {
  const commandId = String(command?.id || '').trim();
  if (!commandId) return null;
  const commandType = String(command?.command_type || '').trim();
  const cachedResults = await readCloudCommandResults();
  let commandResult = cachedResults[commandId] || null;
  const payload =
    command.payload && typeof command.payload === 'object'
      ? command.payload
      : {};
  const requestId = String(
    payload.controlTaskId || command.control_task_id || command.client_task_id || '',
  ).trim();
  const targetedAttemptId = String(
    payload.targetedAttemptId ||
      payload.targeted_attempt_id ||
      payload.attemptId ||
      payload.attempt_id ||
      payload.clientAttemptId ||
      payload.client_attempt_id ||
      command.attempt_id ||
      command.client_attempt_id ||
      '',
  ).trim();

  if (commandType === 'create' && isCloudTargetedPostPayload(payload)) {
    const targeted = await executeCloudTargetedPostCreateCommand(
      command,
      payload,
      commandResult,
    );
    if (targeted.deferred) {
      return {
        ok: true,
        deferred: true,
        reason: targeted.reason,
        commandId,
      };
    }
    commandResult = targeted.commandResult;
    return await cloudTaskAgentApi.completeCommand({
      token,
      commandId,
      success: commandResult?.accepted === true,
      result: commandResult,
    });
  }

  if (commandType === 'create') {
    const clientTaskId = String(
      payload.clientTaskId || command.client_task_id || '',
    ).trim();
    const executionMode =
      String(payload.executionMode || '').trim() === 'unattended_plan'
        ? 'unattended_plan'
        : 'one_time';
    const planOperation =
      executionMode === 'unattended_plan' &&
      String(payload.planOperation || '').trim() === 'delete'
        ? 'delete'
        : 'save';
    if (
      executionMode === 'unattended_plan' &&
      (!commandResult || commandResult.state === 'executing')
    ) {
      if (planOperation === 'delete') {
        if (!clientTaskId) {
          commandResult = await rememberCloudCommandResult(commandId, {
            state: 'completed',
            accepted: false,
            reason: 'invalid_task_payload',
            requestId: clientTaskId,
            executionMode,
            planOperation,
            message: '云端删除计划指令缺少有效标识',
          });
        } else {
          await rememberCloudCommandResult(commandId, {
            state: 'executing',
            accepted: false,
            reason: 'executing',
            requestId: clientTaskId,
            executionMode,
            planOperation,
          });
          try {
            await clearUnattendedKeywordPlan({confirmCloudScope: true});
            commandResult = await rememberCloudCommandResult(
              commandId,
              summarizeCloudPlanDeleteResult(commandId, clientTaskId),
            );
          } catch (error) {
            commandResult = await rememberCloudCommandResult(commandId, {
              state: 'completed',
              accepted: false,
              reason: String(error?.code || 'plan_delete_failed'),
              requestId: clientTaskId,
              executionMode,
              planOperation,
              message: String(error?.message || '设备删除无人值守计划失败').slice(
                0,
                1000,
              ),
            });
          }
        }
      } else {
        const planSource =
          payload.planSnapshot && typeof payload.planSnapshot === 'object'
            ? payload.planSnapshot
            : {};
        const platform = normalizePlatformId(
          planSource.platform || payload.platform || command.platform,
        );
        const keywords = normalizeKeywordList(planSource.keywords);
        if (
          !clientTaskId ||
          !['xiaohongshu', 'douyin'].includes(platform) ||
          keywords.length === 0
        ) {
          commandResult = await rememberCloudCommandResult(commandId, {
            state: 'completed',
            accepted: false,
            reason: 'invalid_task_payload',
            requestId: clientTaskId,
            executionMode,
            planOperation,
            message: '云端计划缺少有效的平台或关键词',
          });
        } else {
          await rememberCloudCommandResult(commandId, {
            state: 'executing',
            accepted: false,
            reason: 'executing',
            requestId: clientTaskId,
            executionMode,
          });
          try {
            const plan = await saveUnattendedKeywordPlan(
              {
                ...planSource,
                enabled: true,
                platform,
                keywords,
              },
              {confirmCloudScope: true},
            );
            commandResult = await rememberCloudCommandResult(
              commandId,
              summarizeCloudPlanSaveResult(plan, commandId, clientTaskId),
            );
          } catch (error) {
            commandResult = await rememberCloudCommandResult(commandId, {
              state: 'completed',
              accepted: false,
              reason: String(error?.code || 'plan_save_failed'),
              requestId: clientTaskId,
              executionMode,
              message: String(error?.message || '设备保存无人值守计划失败').slice(
                0,
                1000,
              ),
            });
          }
        }
      }
    } else if (!commandResult || commandResult.state === 'executing') {
      const [currentRequest, ledger] = await Promise.all([
        readUnattendedKeywordRunRequest(),
        readTaskLedger(),
      ]);
      const reconciledRun =
        currentRequest?.id === clientTaskId ||
        currentRequest?.cloudCommandId === commandId
          ? currentRequest
          : (Array.isArray(ledger?.runs) ? ledger.runs : []).find(
              (run) =>
                run?.id === clientTaskId ||
                run?.metadata?.cloudCommandId === commandId,
            ) || null;
      if (reconciledRun) {
        commandResult = await rememberCloudCommandResult(commandId, {
          state: 'completed',
          accepted: true,
          reason: 'reconciled',
          requestId: String(reconciledRun.id || clientTaskId),
          cloudCommandId: commandId,
          message: '已对账到设备创建的云端任务',
        });
      } else {
        const planSource =
          payload.planSnapshot && typeof payload.planSnapshot === 'object'
            ? payload.planSnapshot
            : {};
        const platform = normalizePlatformId(
          planSource.platform || payload.platform || command.platform,
        );
        const keywords = normalizeKeywordList(planSource.keywords);
        if (
          !clientTaskId ||
          !['xiaohongshu', 'douyin'].includes(platform) ||
          keywords.length === 0
        ) {
          commandResult = await rememberCloudCommandResult(commandId, {
            state: 'completed',
            accepted: false,
            reason: 'invalid_task_payload',
            requestId: clientTaskId,
            message: '云端任务缺少有效的平台或关键词',
          });
        } else if (
          currentRequest &&
          !isTerminalUnattendedRunStatus(currentRequest.status)
        ) {
          return {
            ok: true,
            deferred: true,
            reason: 'unattended_task_busy',
            commandId,
          };
        } else {
          const activeLock = await readActiveCaptureExecutionLock();
          if (activeLock) {
            return {
              ok: true,
              deferred: true,
              reason: 'capture_lock_busy',
              commandId,
            };
          }
          await rememberCloudCommandResult(commandId, {
            state: 'executing',
            accepted: false,
            reason: 'executing',
            requestId: clientTaskId,
          });
          try {
            const request = await launchUnattendedKeywordRun(
              {
                ...planSource,
                enabled: true,
                platform,
                keywords,
              },
              {
                reason: 'cloud_assignment',
                requestId: clientTaskId,
                cloudCommandId: commandId,
                cloudAssigned: true,
                executionMode,
                orchestrationContext: normalizeOrchestrationExecutionContext({
                  ...(payload.orchestration &&
                  typeof payload.orchestration === 'object'
                    ? payload.orchestration
                    : {}),
                  attemptIdentity: payload.attemptIdentity,
                }),
                checkpoint:
                  payload.checkpoint && typeof payload.checkpoint === 'object'
                    ? payload.checkpoint
                    : null,
              },
            );
            if (!request) {
              return {
                ok: true,
                deferred: true,
                reason: 'unattended_task_race',
                commandId,
              };
            }
            commandResult = await rememberCloudCommandResult(
              commandId,
              summarizeCloudCreationResult(request, commandId),
            );
          } catch (error) {
            commandResult = await rememberCloudCommandResult(commandId, {
              state: 'completed',
              accepted: false,
              reason: String(error?.code || 'create_failed'),
              requestId: clientTaskId,
              message: String(error?.message || '设备创建云端任务失败').slice(
                0,
                1000,
              ),
            });
          }
        }
      }
    }
  } else if (commandType === 'stop') {
    if (!commandResult || commandResult.state === 'executing') {
      await rememberCloudCommandResult(commandId, {
        state: 'executing',
        accepted: false,
        reason: 'executing',
        requestId,
        attemptId: targetedAttemptId,
      });
      const targetedStop = cloudTargetedPostApi?.mergeRunPatch
        ? await cancelTargetedPostRunFromControl(requestId, targetedAttemptId)
        : {matched: false};
      const stopped = targetedStop.matched
        ? targetedStop
        : await cancelUnattendedKeywordRunFromControl({
            requestId,
            message: '后台远程中止当前采集任务',
          });
      commandResult = await rememberCloudCommandResult(commandId, {
        state: 'completed',
        accepted: stopped.accepted === true,
        reason: stopped.reason,
        requestId,
        attemptId: targetedAttemptId,
        message:
          stopped.accepted === true
            ? stopped.reason === 'already_terminal'
              ? '任务已经结束，无需重复停止'
              : '设备已停止当前任务并保留已有结果'
            : '设备未找到需要停止的当前任务',
      });
    }
  } else if (commandType !== 'resume') {
    if (!commandResult || commandResult.state === 'executing') {
      commandResult = await rememberCloudCommandResult(commandId, {
        state: 'completed',
        accepted: false,
        reason: 'unsupported_command',
        message: '当前扩展版本不支持该远程指令',
      });
    }
  } else if (!commandResult || commandResult.state === 'executing') {
    const [currentRequest, ledger] = await Promise.all([
      readUnattendedKeywordRunRequest(),
      readTaskLedger(),
    ]);
    const reconciledRun =
      currentRequest?.cloudCommandId === commandId
        ? currentRequest
        : (Array.isArray(ledger?.runs) ? ledger.runs : []).find(
            (run) => run?.metadata?.cloudCommandId === commandId,
          ) || null;
    if (reconciledRun) {
      commandResult = await rememberCloudCommandResult(commandId, {
        state: 'completed',
        accepted: true,
        reason: 'reconciled',
        requestId: String(reconciledRun.id || ''),
        parentRequestId: String(
          reconciledRun.parentRequestId || reconciledRun.metadata?.parentRequestId || requestId,
        ),
        message: '已对账到设备创建的恢复任务',
      });
    } else {
      const recoverableRequest =
        currentRequest?.id === requestId
          ? currentRequest
          : await readArchivedUnattendedKeywordRunRequest(requestId);
      if (!recoverableRequest) {
        commandResult = await rememberCloudCommandResult(commandId, {
          state: 'completed',
          accepted: false,
          reason: 'not_found',
          requestId,
          message: '设备未保留该任务的恢复快照，无法重复创建恢复任务',
        });
      } else if (
        currentRequest &&
        currentRequest.id !== requestId &&
        !isTerminalUnattendedRunStatus(currentRequest.status)
      ) {
        return {
          ok: true,
          deferred: true,
          reason: 'unattended_task_busy',
          commandId,
        };
      } else {
        await rememberCloudCommandResult(commandId, {
          state: 'executing',
          accepted: false,
          reason: 'executing',
          requestId,
        });
        const recovery = await manuallyRecoverUnattendedKeywordRun({
          requestId,
          mode: String(payload.mode || 'remaining'),
          cloudCommandId: commandId,
          allowedKeywords: payload.allowedKeywords,
        });
        commandResult = await rememberCloudCommandResult(
          commandId,
          summarizeCloudRecoveryResult(recovery),
        );
      }
    }
  }

  return await cloudTaskAgentApi.completeCommand({
    token,
    commandId,
    success: commandResult.accepted === true,
    result: commandResult,
  });
}

async function syncCloudTaskAgentLiveness({reason = 'liveness'} = {}) {
  if (!cloudTaskAgentApi?.sendLiveness) {
    return {ok: false, skipped: true, reason: 'cloud_agent_unavailable'};
  }
  if (cloudTaskAgentLivenessInFlight) {
    return {ok: false, skipped: true, reason: 'liveness_in_flight'};
  }
  const credential = await readCloudTaskAgentCredential();
  if (!credential.id || !credential.token) {
    return {ok: false, skipped: true, reason: 'missing_agent_credential'};
  }

  cloudTaskAgentLivenessInFlight = true;
  try {
    return await cloudTaskAgentApi.sendLiveness({
      token: credential.token,
      body: {
        reason: String(reason || 'liveness').slice(0, 120),
        sentAt: new Date().toISOString(),
      },
    });
  } finally {
    cloudTaskAgentLivenessInFlight = false;
  }
}

async function syncCloudTaskAgent({reason = 'heartbeat', force = false} = {}) {
  if (!cloudTaskAgentApi?.buildHeartbeatPayload || !cloudTaskAgentApi?.sendHeartbeat) {
    return {ok: false, skipped: true, reason: 'cloud_agent_unavailable'};
  }
  if (cloudTaskAgentSyncInFlight) {
    cloudTaskAgentSyncPending = true;
    return {ok: false, skipped: true, reason: 'sync_in_flight'};
  }
  if (cloudTaskAgentRetryNotBefore > Date.now()) {
    const remainingMs = cloudTaskAgentRetryNotBefore - Date.now();
    scheduleCloudTaskAgentSync(`${reason}_after_backoff`, remainingMs);
    return {
      ok: false,
      skipped: true,
      reason: 'failure_backoff',
      retryAfterMs: remainingMs,
    };
  }
  if (
    !force &&
    cloudTaskAgentLastSyncAt > 0 &&
    Date.now() - cloudTaskAgentLastSyncAt < CLOUD_TASK_AGENT_ACTIVE_THROTTLE_MS
  ) {
    const remainingMs = Math.max(
      25,
      CLOUD_TASK_AGENT_ACTIVE_THROTTLE_MS - (Date.now() - cloudTaskAgentLastSyncAt) + 25,
    );
    scheduleCloudTaskAgentSync(`${reason}_after_throttle`, remainingMs);
    return {ok: false, skipped: true, reason: 'throttled'};
  }

  const credential = await readCloudTaskAgentCredential();
  if (!credential.id || !credential.token) {
    return {ok: false, skipped: true, reason: 'missing_agent_credential'};
  }

  cloudTaskAgentSyncInFlight = true;
  try {
    const degradedHealth = [];
    const markDegraded = (code) => {
      const normalized = String(code || '').trim().toLowerCase();
      if (normalized && !degradedHealth.includes(normalized)) {
        degradedHealth.push(normalized);
      }
    };
    const cleanup = await compactExpiredControlStorage({
      reason: 'heartbeat',
    }).catch(() => ({ok: false, failures: [{area: 'control_storage'}]}));
    if (cleanup.ok === false) {
      for (const failure of cleanup.failures || []) {
        markDegraded(`cleanup_${failure.area || 'unknown'}_failed`);
      }
    }
    // A previous terminal runner may have finished cleanup after the heartbeat
    // that carried its terminal status. Re-evaluate the exact local predicate
    // before reading the ledger so this same heartbeat can carry closure proof.
    await reconcileUnattendedLocalClosureEvidence({
      closeOwnedRunnerTabs: true,
    }).catch((error) => {
      console.warn('[CloudTaskAgent] local closure reconcile failed:', error);
      markDegraded('local_closure_reconcile_failed');
    });
    let agentStatus = {};
    let agentScopeKnown = true;
    try {
      agentStatus = await ensureCloudTaskAgentScope(credential.id);
    } catch (error) {
      agentScopeKnown = false;
      markDegraded('agent_scope_state_unavailable');
      console.warn('[CloudTaskAgent] agent scope unavailable:', error);
    }

    let runtime;
    try {
      runtime = await ensureRuntimeState();
    } catch (error) {
      markDegraded('runtime_state_write_failed');
      console.warn('[CloudTaskAgent] runtime state degraded:', error);
      try {
        runtime = await readRuntimeState();
      } catch (readError) {
        markDegraded('runtime_state_read_failed');
        runtime = {};
      }
    }
    runtime = {
      ...(runtime && typeof runtime === 'object' ? runtime : {}),
      clientLabel: String(runtime?.clientLabel || getPlatformLabel()),
      appVersion: String(runtime?.appVersion || getAppVersion()),
    };

    let ledger = {};
    let stored = {};
    let taskStateKnown = agentScopeKnown;
    if (agentScopeKnown) {
      try {
        [ledger, stored] = await Promise.all([
          readTaskLedger(),
          chrome.storage.local.get([
            STORAGE_KEYS.unattendedKeywordRunRequest,
            STORAGE_KEYS.unattendedKeywordPlan,
            STORAGE_KEYS.targetedPostRunRequest,
          ]),
        ]);
      } catch (error) {
        taskStateKnown = false;
        ledger = {};
        stored = {};
        markDegraded('task_state_unavailable');
        console.warn('[CloudTaskAgent] task state unavailable:', error);
      }
    } else {
      markDegraded('task_state_scope_unknown');
    }

    const [observedResult, usageResult] = await Promise.allSettled([
      refreshObservedSocialAccounts(),
      readSocialAccountUsageQueue(),
    ]);
    const observedSocialAccountsKnown = observedResult.status === 'fulfilled';
    const socialUsageEventsKnown = usageResult.status === 'fulfilled';
    if (!observedSocialAccountsKnown) {
      markDegraded('social_account_state_unavailable');
    }
    if (!socialUsageEventsKnown) {
      markDegraded('social_usage_state_unavailable');
    }
    const observedSocialAccounts = observedSocialAccountsKnown
      ? observedResult.value
      : {accounts: []};
    const socialUsageEvents = socialUsageEventsKnown
      ? usageResult.value
      : [];
    const scopedLedger = taskStateKnown
      ? buildCloudScopedTaskLedger(
          ledger,
          agentStatus.scopeStartedAt,
          credential.id,
        )
      : {};
    const scopedPlan = taskStateKnown
      ? buildCloudScopedUnattendedPlan(
          stored[STORAGE_KEYS.unattendedKeywordPlan],
          agentStatus,
          credential.id,
        )
      : null;
    const reportedLastError = normalizeCloudTaskAgentError(
      agentStatus.lastError || cloudTaskAgentLastError,
    );
    const degradedLastError = degradedHealth.length > 0
      ? `LOCAL_HEARTBEAT_DEGRADED:${degradedHealth.join(',')}`
      : '';
    const payload = cloudTaskAgentApi.buildHeartbeatPayload({
      runtime,
      ledger: scopedLedger,
      unattendedRequest: taskStateKnown
        ? stored[STORAGE_KEYS.unattendedKeywordRunRequest]
        : null,
      targetedPostRequest: taskStateKnown
        ? stored[STORAGE_KEYS.targetedPostRunRequest]
        : null,
      unattendedPlan: scopedPlan,
      observedSocialAccounts: Array.isArray(observedSocialAccounts?.accounts)
        ? observedSocialAccounts.accounts
        : [],
      socialUsageEvents,
      reason,
      lastError: [reportedLastError, degradedLastError]
        .filter(Boolean)
        .join(' | '),
      agentId: credential.id,
      taskStateKnown,
      unattendedPlanKnown: taskStateKnown,
      observedSocialAccountsKnown,
      socialUsageEventsKnown,
      degradedHealth,
    });
    const response = await cloudTaskAgentApi.sendHeartbeat({
      token: credential.token,
      body: payload,
    });
    if (!response?.ok) {
      recordCloudTaskAgentFailure();
      await rememberCloudTaskAgentError(
        response?.message || response?.reason || '云端任务中心同步失败',
      ).catch((error) => {
        console.warn('[CloudTaskAgent] failed to persist sync error:', error);
      });
      return response;
    }

    clearCloudTaskAgentFailureBackoff();
    cloudTaskAgentLastSyncAt = Date.now();
    if (reportedLastError) {
      await clearReportedCloudTaskAgentError(reportedLastError);
      cloudTaskAgentSyncPending = true;
    } else {
      cloudTaskAgentLastError = '';
    }
    if (
      socialUsageEventsKnown &&
      Array.isArray(response.acceptedSocialUsageEventIds)
    ) {
      await acknowledgeSocialAccountUsageEvents(
        response.acceptedSocialUsageEventIds,
      );
    }
    const commands = Array.isArray(response.commands) ? response.commands : [];
    for (const command of commands) {
      try {
        await executeCloudTaskAgentCommand(command, credential.token);
      } catch (error) {
        await rememberCloudTaskAgentError(
          error?.message || '远程指令执行失败',
        );
        console.warn('[CloudTaskAgent] command execution failed:', error);
      }
    }
    return response;
  } finally {
    cloudTaskAgentSyncInFlight = false;
    if (cloudTaskAgentSyncPending) {
      cloudTaskAgentSyncPending = false;
      setTimeout(() => {
        syncCloudTaskAgent({reason: 'pending_state_changes', force: true}).catch(
          (error) => console.warn('[CloudTaskAgent] pending sync failed:', error),
        );
      }, 0);
    }
  }
}

function scheduleCloudTaskAgentSync(reason = 'state_changed', delayMs = 250) {
  if (cloudTaskAgentSyncInFlight) {
    cloudTaskAgentSyncPending = true;
    return;
  }
  if (cloudTaskAgentSyncTimer !== null) return;
  cloudTaskAgentSyncTimer = setTimeout(() => {
    cloudTaskAgentSyncTimer = null;
    syncCloudTaskAgent({reason}).catch((error) => {
      console.warn('[CloudTaskAgent] state sync failed:', error);
    });
  }, Math.max(0, Number(delayMs) || 0));
}

async function syncCloudTaskAgentAlarm() {
  await chrome.alarms.create(CLOUD_TASK_AGENT_ALARM_NAME, {
    periodInMinutes: CLOUD_TASK_AGENT_PERIOD_MINUTES,
  });
}

let lastControlStorageCleanupAt = 0;

function storedRecordTimestamp(value = {}) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const candidate of [
    source.storedAt,
    source.updatedAt,
    source.finishedAt,
    source.createdAt,
    source.occurredAt,
    source.at,
    source.timestamp,
  ]) {
    const parsed = Date.parse(String(candidate || ''));
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

async function compactExpiredTaskLedger(now) {
  return await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.taskLedger);
    const raw = stored[STORAGE_KEYS.taskLedger];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {changed: false};
    }
    const rawRuns = Array.isArray(raw.runs) ? raw.runs : [];
    const safelyExpiredTerminalStatuses = new Set([
      'completed',
      'completed_with_warnings',
      'completed_with_failures',
      'failed',
      'canceled',
      'skipped',
    ]);
    const retainedRuns = rawRuns.filter((run) => {
      const status = String(run?.status || '').trim().toLowerCase();
      // needs_action remains operator-recoverable. Nonterminal and unknown
      // statuses are also preserved byte-for-byte instead of being normalized.
      if (!safelyExpiredTerminalStatuses.has(status)) return true;
      const timestamps = [
        run?.storedAt,
        run?.archivedAt,
        run?.finishedAt,
        run?.businessProgressAt,
        run?.heartbeatAt,
        run?.updatedAt,
        run?.startedAt,
        run?.createdAt,
      ]
        .map(candidate => {
          const parsed = Date.parse(String(candidate || ''));
          if (Number.isFinite(parsed)) return parsed;
          const numeric = Number(candidate);
          return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
        })
        .filter(timestamp => timestamp > 0);
      // An unknown age can never prove expiry. If timestamps disagree, use the
      // newest fact so cleanup cannot discard a recently touched terminal row.
      const latestTimestamp = timestamps.length > 0
        ? Math.max(...timestamps)
        : 0;
      return !latestTimestamp ||
        now - latestTimestamp <= TASK_LEDGER_TERMINAL_RETENTION_MS;
    });
    if (retainedRuns.length === rawRuns.length) {
      return {changed: false};
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.taskLedger]: {
        ...raw,
        runs: retainedRuns,
      },
    });
    return {changed: true};
  });
}

async function compactExpiredUnattendedArchive(now) {
  return await runUnattendedRunArchiveMutation(async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.unattendedKeywordRunArchive,
      STORAGE_KEYS.auth,
    ]);
    const raw = stored[STORAGE_KEYS.unattendedKeywordRunArchive];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {changed: false};
    }
    const auth =
      stored[STORAGE_KEYS.auth] &&
      typeof stored[STORAGE_KEYS.auth] === 'object' &&
      !Array.isArray(stored[STORAGE_KEYS.auth])
        ? stored[STORAGE_KEYS.auth]
        : {};
    const agentId = String(auth.captureAgent?.id || '').trim();
    const compacted = normalizeUnattendedKeywordRunArchive(
      raw,
      now,
      agentId,
    );
    if (JSON.stringify(compacted) === JSON.stringify(raw)) {
      return {changed: false};
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.unattendedKeywordRunArchive]: compacted,
    });
    return {changed: true};
  });
}

async function compactExpiredAuxiliaryHistory(now) {
  return await runCloudCommandResultsMutation(async () => {
    const commandResults = await readCloudCommandResults();
    const retained = Object.fromEntries(
      Object.entries(commandResults).filter(([, value]) => {
        const timestamp = storedRecordTimestamp(value);
        return !timestamp || now - timestamp <= CLOUD_COMMAND_RESULT_RETENTION_MS;
      }),
    );
    if (Object.keys(retained).length === Object.keys(commandResults).length) {
      return {changed: false};
    }
    if (Object.keys(retained).length > 0) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.cloudCommandResults]: retained,
      });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.cloudCommandResults);
    }
    return {changed: true};
  });
}

async function compactExpiredControlStorage({
  force = false,
  reason = 'heartbeat',
} = {}) {
  const now = Date.now();
  if (
    !force &&
    lastControlStorageCleanupAt > 0 &&
    now - lastControlStorageCleanupAt < CONTROL_STORAGE_CLEANUP_INTERVAL_MS
  ) {
    return {ok: true, skipped: true, reason: 'cleanup_throttled'};
  }
  lastControlStorageCleanupAt = now;
  const operations = await Promise.allSettled([
    compactExpiredTaskLedger(now),
    compactExpiredUnattendedArchive(now),
    compactExpiredAuxiliaryHistory(now),
  ]);
  const failures = operations
    .map((result, index) => ({result, index}))
    .filter(({result}) => result.status === 'rejected')
    .map(({result, index}) => ({
      area: ['task_ledger', 'unattended_archive', 'auxiliary_history'][index],
      message: String(result.reason?.message || result.reason || '').slice(0, 240),
    }));
  return {
    ok: failures.length === 0,
    reason,
    failures,
    changed: operations.some(
      result => result.status === 'fulfilled' && result.value?.changed === true,
    ),
  };
}

function taskRunActivityAt(run) {
  return Math.max(
    Date.parse(String(run?.businessProgressAt || '')) || 0,
    Date.parse(String(run?.heartbeatAt || '')) || 0,
    Date.parse(String(run?.updatedAt || '')) || 0,
    Date.parse(String(run?.startedAt || '')) || 0,
    Date.parse(String(run?.createdAt || '')) || 0,
  );
}

function isTaskRunActuallyActive(
  run,
  {
    now = Date.now(),
    unattendedRequest = null,
    targetedRequest = null,
    includeRecent = false,
  } = {},
) {
  const taskId = String(run?.id || run?.taskId || '').trim();
  if (!taskId) return false;
  if (captureDebugSessionManager?.getSessionByTaskId(taskId)) return true;
  if (captureTaskOwnerCoordinator?.getOwner(taskId)?.connected === true) {
    return true;
  }
  if (
    includeRecent &&
    now - taskRunActivityAt(run) < TASK_CENTER_RECENT_ACTIVITY_MS
  ) {
    return true;
  }

  const requestId = String(
    unattendedRequest?.id || unattendedRequest?.requestId || '',
  ).trim();
  if (requestId === taskId) {
    const requestStatus = String(unattendedRequest?.status || '').toLowerCase();
    if (UNATTENDED_RUN_TERMINAL_STATUSES.has(requestStatus)) return false;
    const requestActivityAt = taskRunActivityAt(unattendedRequest);
    return Boolean(
      requestActivityAt &&
        now - requestActivityAt < UNATTENDED_RUN_ACTIVE_GRACE_MS,
    );
  }

  const targetedRequestId = targetedPostPhysicalRunId(targetedRequest);
  if (targetedRequestId !== taskId) return false;
  if (
    cloudTargetedPostApi?.isTerminalRunStatus?.(
      String(targetedRequest?.status || ''),
    )
  ) {
    return false;
  }
  const targetedActivityAt = taskRunActivityAt(targetedRequest);
  return Boolean(
    targetedActivityAt &&
      now - targetedActivityAt < UNATTENDED_RUN_ACTIVE_GRACE_MS,
  );
}

async function clearTaskCenterRecords() {
  return await runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.taskLedger,
      STORAGE_KEYS.unattendedKeywordPlan,
      STORAGE_KEYS.unattendedKeywordRunRequest,
      STORAGE_KEYS.targetedPostRunRequest,
    ]);
    const core = getUnattendedTaskCenterCore();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const unattendedRequest =
      stored[STORAGE_KEYS.unattendedKeywordRunRequest] &&
      typeof stored[STORAGE_KEYS.unattendedKeywordRunRequest] === 'object'
        ? stored[STORAGE_KEYS.unattendedKeywordRunRequest]
        : null;
    const unattendedRequestId = String(
      unattendedRequest?.id || unattendedRequest?.requestId || '',
    ).trim();
    const unattendedRequestStatus = String(
      unattendedRequest?.status || '',
    ).toLowerCase();
    const unattendedRequestActive = Boolean(
      unattendedRequestId &&
        !UNATTENDED_RUN_TERMINAL_STATUSES.has(unattendedRequestStatus) &&
        isTaskRunActuallyActive(
          {...unattendedRequest, id: unattendedRequestId},
          {now, unattendedRequest},
        ),
    );
    const targetedRequest =
      stored[STORAGE_KEYS.targetedPostRunRequest] &&
      typeof stored[STORAGE_KEYS.targetedPostRunRequest] === 'object'
        ? stored[STORAGE_KEYS.targetedPostRunRequest]
        : null;
    const targetedRequestId = targetedPostLogicalRequestId(targetedRequest);
    const targetedPhysicalRunId = targetedPostPhysicalRunId(targetedRequest);
    const targetedRequestActive = Boolean(
      targetedRequestId &&
        targetedPhysicalRunId &&
        !cloudTargetedPostApi?.isTerminalRunStatus?.(
          String(targetedRequest?.status || ''),
        ) &&
        isTaskRunActuallyActive(
          {...targetedRequest, id: targetedPhysicalRunId},
          {now, targetedRequest},
        ),
    );
    const normalized = core?.normalizeTaskLedger
      ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
      : stored[STORAGE_KEYS.taskLedger] || {version: 1, runs: []};
    const runs = Array.isArray(normalized?.runs) ? normalized.runs : [];
    const preservedRuns = runs.filter((run) => {
      if (core?.isTerminalTaskStatus?.(run?.status)) return false;
      return isTaskRunActuallyActive(run, {
        now,
        unattendedRequest: stored[STORAGE_KEYS.unattendedKeywordRunRequest],
        targetedRequest: stored[STORAGE_KEYS.targetedPostRunRequest],
        includeRecent: true,
      });
    });
    const ledgerInput = {
      ...normalized,
      runs: preservedRuns,
      clearedAt: nowIso,
      updatedAt: nowIso,
    };
    const ledger = core?.normalizeTaskLedger
      ? core.normalizeTaskLedger(ledgerInput, {now})
      : ledgerInput;
    await chrome.storage.local.set({
      [STORAGE_KEYS.taskLedger]: ledger,
      [STORAGE_KEYS.syncHistory]: {
        entries: [],
        lastUpdatedAt: now,
      },
    });
    await clearUnattendedKeywordRunArchive();
    let clearedUnattendedRequest = false;
    if (!unattendedRequestActive) {
      if (unattendedRequestId) {
        await chrome.storage.local.remove(
          STORAGE_KEYS.unattendedKeywordRunRequest,
        );
        clearedUnattendedRequest = true;
      }
      const unattendedPlan = stored[STORAGE_KEYS.unattendedKeywordPlan];
      if (
        unattendedPlan &&
        typeof unattendedPlan === 'object' &&
        (unattendedPlan.lastRunAt ||
          unattendedPlan.lastRunStatus ||
          unattendedPlan.lastRunMessage ||
          unattendedPlan.lastRunProgress)
      ) {
        await chrome.storage.local.set({
          [STORAGE_KEYS.unattendedKeywordPlan]: {
            ...unattendedPlan,
            lastRunAt: '',
            lastRunStatus: '',
            lastRunMessage: '',
            lastRunProgress: null,
            updatedAt: nowIso,
          },
        });
      }
    }
    let clearedTargetedRequest = false;
    if (!targetedRequestActive && targetedRequestId) {
      await chrome.storage.local.remove(STORAGE_KEYS.targetedPostRunRequest);
      clearedTargetedRequest = true;
    }
    return {
      ledger,
      clearedAt: nowIso,
      clearedCount: Math.max(0, runs.length - preservedRuns.length),
      preservedActiveCount: preservedRuns.length,
      clearedUnattendedRequest,
      clearedTargetedRequest,
    };
  });
}

async function upsertTaskLedgerRun({run = null, patch = null, event = null} = {}) {
  const sourceRun =
    run && typeof run === 'object' && !Array.isArray(run) ? run : {};
  const sourcePatch =
    patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const taskId = String(sourcePatch.id || sourceRun.id || '').trim();
  const requestedStatus = String(
    sourcePatch.status || sourceRun.status || '',
  ).trim().toLowerCase();
  const persist = () => runTaskLedgerMutation(async () => {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.taskLedger);
    const core = getUnattendedTaskCenterCore();
    const now = new Date().toISOString();
    let ledger = core?.normalizeTaskLedger
      ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
      : stored[STORAGE_KEYS.taskLedger] || {version: 1, runs: [], updatedAt: ''};
    if (!taskId) {
      return {accepted: false, reason: 'invalid_id', data: null, ledger};
    }
    const existing = Array.isArray(ledger?.runs)
      ? ledger.runs.find((item) => item?.id === taskId) || null
      : null;
    let nextRun = {...(existing || {}), ...sourceRun, ...sourcePatch, id: taskId};
    const cloudAgentScopeId = existing
      ? String(existing?.metadata?.cloudAgentScopeId || '')
      : String((await readCloudTaskAgentCredential()).id || '');
    nextRun.metadata = {
      ...(nextRun.metadata && typeof nextRun.metadata === 'object'
        ? nextRun.metadata
        : {}),
      cloudAgentScopeId,
    };
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
      scheduleCloudTaskAgentSync('task_ledger_changed');
    }
    return {
      accepted: Boolean(result.accepted),
      reason: String(result.reason || ''),
      data: result.run || null,
      ledger: result.ledger,
    };
  });
  return AUTHORITATIVE_CONTROL_TERMINAL_STATUSES.has(requestedStatus)
    ? await runAuthoritativeControlStorageMutation(persist)
    : await persist();
}

async function terminalizeCaptureTaskLedgerRun(
  taskId,
  {
    reason = 'capture_task_canceled',
    message = '采集任务已停止',
    status = 'canceled',
  } = {},
) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) {
    return {accepted: false, reason: 'invalid_id'};
  }
  const rawTerminalStatus =
    String(status || 'canceled').trim().toLowerCase() || 'canceled';
  const terminalStatus =
    {
      partial: 'completed_with_failures',
      success: 'completed',
      succeeded: 'completed',
      done: 'completed',
      error: 'failed',
      stopped: 'canceled',
      cancelled: 'canceled',
    }[rawTerminalStatus] || rawTerminalStatus;
  const terminalReason =
    String(reason || 'capture_task_canceled').trim() ||
    'capture_task_canceled';
  const terminalMessage = String(message || '采集任务已停止').trim();
  const hasTerminalError = new Set([
    'canceled',
    'failed',
    'completed_with_failures',
  ]).has(terminalStatus);
  const eventType =
    terminalStatus === 'failed'
      ? 'task_failed'
      : terminalStatus === 'canceled'
        ? 'task_canceled'
        : 'task_finished';
  const now = new Date().toISOString();
  try {
    return await upsertTaskLedgerRun({
      patch: {
        id: normalizedTaskId,
        status: terminalStatus,
        message: terminalMessage,
        updatedAt: now,
        finishedAt: now,
        businessProgressAt: now,
        error: hasTerminalError
          ? {
              code: terminalReason,
              reason: terminalReason,
              message: terminalMessage,
            }
          : null,
      },
      event: {
        type: eventType,
        status: terminalStatus,
        message: terminalMessage,
        at: now,
        metadata: {
          reason: terminalReason,
        },
      },
    });
  } catch (error) {
    console.warn(
      '[CaptureTask] failed to terminalize task-center record:',
      error,
    );
    throw error;
  }
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

async function cancelUnattendedKeywordRunRequest(
  message,
  {
    requestId = '',
    attemptId = '',
    localOnly = false,
    cancelSource = 'user',
    cancelReason = 'user_canceled',
    errorCode = 'USER_CANCELED',
  } = {},
) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (
      !request ||
      (requestId && request.id !== requestId) ||
      (attemptId && request.attemptId !== attemptId) ||
      (localOnly && request.cloudAssigned === true) ||
      (isTerminalUnattendedRunStatus(request.status) &&
        request.status !== 'needs_action')
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...request,
      status: 'canceled',
      error: {
        code: String(errorCode || 'USER_CANCELED'),
        reason: String(cancelReason || 'user_canceled'),
        category: String(cancelReason || 'user_canceled'),
        message,
        retryable: false,
      },
      metadata: {
        ...(request.metadata && typeof request.metadata === 'object'
          ? request.metadata
          : {}),
        cancelSource: String(cancelSource || 'user'),
        cancelReason: String(cancelReason || 'user_canceled'),
      },
      recoveryPendingLaunch: false,
      recoveryWaitUntil: '',
      wakeGraceUntil: '',
      finishedAt: now,
      updatedAt: now,
      message,
      progress: {
        ...(request.progress && typeof request.progress === 'object'
          ? request.progress
          : {}),
        phase: 'unattended_canceled',
        waitUntil: '',
        remainingMs: null,
        message,
        updatedAt: now,
      },
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: request,
      event: {
        type: 'canceled',
        message,
        at: now,
        metadata: {
          cancelSource: String(cancelSource || 'user'),
          reason: String(cancelReason || 'user_canceled'),
        },
      },
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
      await captureDebugSessionManager?.stopByTab(
        tabId,
        'unattended_cancel_requested',
      );
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

async function cleanupTerminalUnattendedRuntime(request, tabIds = []) {
  const normalizedRequest = normalizeUnattendedRunRequest(request);
  if (!normalizedRequest) return {request: null, relayedCount: 0};
  const expectedRequestId = String(normalizedRequest.id || '').trim();
  const expectedAttemptId = String(normalizedRequest.attemptId || '').trim();
  const persistCleanupState = () => runUnattendedRunMutation(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== expectedRequestId ||
      current.attemptId !== expectedAttemptId ||
      !isTerminalUnattendedRunStatus(current.status)
    ) {
      return null;
    }
    const reconciled = normalizeUnattendedRunRequest({
      ...current,
      recoveryPendingLaunch: false,
      recoveryWaitUntil: '',
      wakeGraceUntil: '',
      progress: {
        ...(current.progress && typeof current.progress === 'object'
          ? current.progress
          : {}),
        phase: `unattended_${current.status}`,
        waitUntil: '',
        remainingMs: null,
      },
    });
    await chrome.storage.local.set({
      [STORAGE_KEYS.unattendedKeywordRunRequest]: reconciled,
    });
    return reconciled;
  });
  const reconciledRequest =
    await runAuthoritativeControlStorageMutation(persistCleanupState);
  if (!reconciledRequest) {
    return {request: normalizedRequest, relayedCount: 0};
  }
  const terminalLock = await snapshotUnattendedKeywordPlanLock();
  const progress = normalizeUnattendedRunProgress(
    reconciledRequest.progress,
    reconciledRequest.message,
  );
  const relayedCount = await cancelAndReleaseUnattendedExecutionTargets(
    terminalLock,
    [
      ...tabIds,
      reconciledRequest.runnerTabId,
      progress?.runnerTabId,
    ],
  );
  // The local ledger can reach a terminal state after the execution lease was
  // already released.  The stable unattended task id is still sufficient to
  // find and close a stranded Debug/group/worker session, so cleanup must not
  // depend on a surviving lock document.
  await releaseUnattendedCaptureTaskResourcesForRecovery(terminalLock, {
    reason: 'unattended_terminal_cleanup',
    request: reconciledRequest,
  }).catch((error) => {
    console.warn('[Background] terminal unattended cleanup pending:', error);
  });
  // The terminal mutation is durable before cleanup begins. Closure evidence
  // is deliberately deferred: the sidebar still needs a chance to drain its
  // checkpoint outbox, and only the background can authoritatively inspect
  // every task-owned resource across Extension documents.
  scheduleCloudTaskAgentSync('unattended_terminal_cleanup', 500);
  return {request: reconciledRequest, relayedCount};
}

function isUnattendedRunnerTabForRequest(
  tab,
  requestId = '',
  attemptId = '',
) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  if (!normalizedRequestId) return false;
  try {
    const candidate = new URL(String(tab?.url || ''));
    const sidebar = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
    return (
      candidate.origin === sidebar.origin &&
      candidate.pathname === sidebar.pathname &&
      candidate.searchParams.get(UNATTENDED_RUNNER_QUERY_KEY) ===
        normalizedRequestId &&
      (!normalizedAttemptId ||
        candidate.searchParams.get(UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY) ===
          normalizedAttemptId)
    );
  } catch {
    return false;
  }
}

function isLegacyUnattendedRunnerTabForRequest(tab, requestId = '') {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) return false;
  try {
    const candidate = new URL(String(tab?.url || ''));
    const sidebar = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
    return (
      candidate.origin === sidebar.origin &&
      candidate.pathname === sidebar.pathname &&
      candidate.searchParams.get(UNATTENDED_RUNNER_QUERY_KEY) ===
        normalizedRequestId &&
      !candidate.searchParams.get(UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY)
    );
  } catch {
    return false;
  }
}

async function inspectUnattendedCheckpointOutboxAttempt(
  requestId,
  attemptId,
) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  let stored;
  try {
    stored = await chrome.storage.local.get(null);
  } catch (error) {
    return {known: false, pendingCount: null, reason: 'outbox_read_failed', error};
  }
  let pendingCount = 0;
  for (const [key, rawValue] of Object.entries(stored || {})) {
    if (!key.startsWith(UNATTENDED_CHECKPOINT_OUTBOX_STORAGE_PREFIX)) {
      continue;
    }
    const value =
      rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? rawValue
        : null;
    if (!value) {
      return {known: false, pendingCount: null, reason: 'outbox_entry_invalid'};
    }
    const entryRequestId = String(value.requestId || '').trim();
    const entryAttemptId = String(value.attemptId || '').trim();
    const entryId = String(value.id || '').trim();
    const revision = String(value.revision || '').trim();
    const patch =
      value.patch &&
      typeof value.patch === 'object' &&
      !Array.isArray(value.patch)
        ? value.patch
        : null;
    if (
      !entryRequestId ||
      !entryAttemptId ||
      !entryId ||
      entryId !== `${entryRequestId}:${entryAttemptId}` ||
      !revision ||
      key !== `${UNATTENDED_CHECKPOINT_OUTBOX_STORAGE_PREFIX}${revision}` ||
      !patch ||
      !patch.checkpoint ||
      typeof patch.checkpoint !== 'object' ||
      Array.isArray(patch.checkpoint)
    ) {
      // A malformed durable row cannot be attributed away from this attempt.
      // Treat it as unknown instead of manufacturing a zero-pending result.
      return {known: false, pendingCount: null, reason: 'outbox_identity_unknown'};
    }
    if (
      entryRequestId === normalizedRequestId &&
      entryAttemptId === normalizedAttemptId
    ) {
      const deliveryStatus = String(
        value.deliveryStatus || value.outboxStatus || '',
      ).trim().toLowerCase();
      const acknowledged = Boolean(
        value.acknowledged === true ||
        value.acked === true ||
        value.delivered === true ||
        value.acknowledgedAt ||
        value.ackedAt ||
        value.deliveredAt ||
        ['acked', 'acknowledged', 'delivered'].includes(deliveryStatus)
      );
      if (!acknowledged) pendingCount += 1;
    }
  }
  return {known: true, pendingCount, reason: ''};
}

function resolveUnattendedClosureItemIdentities(request = {}) {
  const context =
    request.orchestrationContext &&
    typeof request.orchestrationContext === 'object' &&
    !Array.isArray(request.orchestrationContext)
      ? request.orchestrationContext
      : {};
  const attempts = Array.isArray(context.itemAttempts)
    ? context.itemAttempts.filter((candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        String(candidate.itemId || '').trim() &&
        String(candidate.attemptId || '').trim() &&
        Number.isSafeInteger(Number(candidate.attemptNumber)) &&
        Number(candidate.attemptNumber) > 0 &&
        Number.isSafeInteger(Number(candidate.assignmentRevision)) &&
        Number(candidate.assignmentRevision) >= 0,
      )
    : [];
  if (attempts.length === 0) return [];
  const identities = attempts.map(attempt => ({
    itemId: String(attempt.itemId || '').trim(),
    itemAttemptId: String(attempt.attemptId || '').trim(),
    attemptNumber: Number(attempt.attemptNumber),
    assignmentRevision: Number(attempt.assignmentRevision),
  }));
  const unique = new Set(
    identities.map(identity =>
      `${identity.itemId}:${identity.itemAttemptId}`,
    ),
  );
  return unique.size === identities.length ? identities : [];
}

function inspectUnattendedBusinessUploadEvidence(request = {}) {
  const progress =
    request.progress &&
    typeof request.progress === 'object' &&
    !Array.isArray(request.progress)
      ? request.progress
      : {};
  const exactCount = (value) =>
    Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;
  if (
    progress.streamingSyncEvidenceKnown !== true ||
    progress.streamingSyncDrainCompleted !== true ||
    typeof progress.streamingSyncEnabled !== 'boolean' ||
    typeof progress.streamingSyncBlocked !== 'boolean' ||
    typeof progress.streamingSyncCanceled !== 'boolean'
  ) {
    return {known: false, reason: 'business_upload_state_unknown'};
  }
  if (
    String(progress.unattendedRequestId || '').trim() !==
      String(request.id || '').trim() ||
    String(progress.unattendedAttemptId || '').trim() !==
      String(request.attemptId || '').trim() ||
    String(progress.progressScope || '').trim().toLowerCase() !== 'terminal'
  ) {
    return {known: false, reason: 'business_upload_attempt_mismatch'};
  }
  const fields = {
    streamingSyncEnqueuedCount: exactCount(
      progress.streamingSyncEnqueuedCount,
    ),
    streamingSyncProcessedCount: exactCount(
      progress.streamingSyncProcessedCount,
    ),
    streamingSyncSuccessCount: exactCount(
      progress.streamingSyncSuccessCount,
    ),
    streamingSyncFailedCount: exactCount(
      progress.streamingSyncFailedCount,
    ),
    streamingSyncSkippedCount: exactCount(
      progress.streamingSyncSkippedCount,
    ),
    streamingSyncPendingCount: exactCount(
      progress.streamingSyncPendingCount,
    ),
    streamingSyncActiveCount: exactCount(
      progress.streamingSyncActiveCount,
    ),
    streamingSyncRemainingCount: exactCount(
      progress.streamingSyncRemainingCount,
    ),
    capturedRecordCount: exactCount(progress.capturedRecordCount),
  };
  if (Object.values(fields).some((value) => value === null)) {
    return {known: false, reason: 'business_upload_counts_unknown'};
  }
  const requestSavedCount = exactCount(request.counts?.saved);
  if (
    requestSavedCount === null ||
    requestSavedCount !== fields.capturedRecordCount
  ) {
    return {known: false, reason: 'business_upload_capture_count_mismatch'};
  }
  const enabled = progress.streamingSyncEnabled === true;
  const completelyDrained = Boolean(
    progress.streamingSyncBlocked === false &&
    progress.streamingSyncCanceled === false &&
    fields.streamingSyncPendingCount === 0 &&
    fields.streamingSyncActiveCount === 0 &&
    fields.streamingSyncRemainingCount === 0 &&
    fields.streamingSyncFailedCount === 0 &&
    fields.streamingSyncSkippedCount === 0
  );
  const everyCapturedRecordUploaded = enabled
    ? fields.streamingSyncEnqueuedCount === fields.capturedRecordCount &&
      fields.streamingSyncProcessedCount === fields.streamingSyncEnqueuedCount &&
      fields.streamingSyncSuccessCount === fields.streamingSyncEnqueuedCount
    : fields.capturedRecordCount === 0 &&
      fields.streamingSyncEnqueuedCount === 0 &&
      fields.streamingSyncProcessedCount === 0 &&
      fields.streamingSyncSuccessCount === 0;
  const cleared = completelyDrained && everyCapturedRecordUploaded;
  return {
    known: true,
    cleared,
    reason: cleared
      ? 'business_uploads_cleared'
      : 'business_uploads_not_cleared',
    state: {
      businessUploadEvidenceKnown: true,
      streamingSyncDrainCompleted: true,
      streamingSyncEnabled: enabled,
      ...fields,
      streamingSyncBlocked: progress.streamingSyncBlocked,
      streamingSyncCanceled: progress.streamingSyncCanceled,
    },
  };
}

async function inspectUnattendedLocalClosurePredicate(
  request,
  {closeOwnedRunnerTabs = false} = {},
) {
  const normalized = normalizeUnattendedRunRequest(request);
  if (
    !normalized ||
    !isTerminalUnattendedRunStatus(normalized.status) ||
    !String(normalized.attemptId || '').trim()
  ) {
    return {closed: false, reason: 'request_not_terminal'};
  }
  const itemIdentities = resolveUnattendedClosureItemIdentities(normalized);
  if (itemIdentities.length === 0) {
    return {closed: false, reason: 'item_attempt_identity_unknown'};
  }
  const businessUploads = inspectUnattendedBusinessUploadEvidence(normalized);
  if (!businessUploads.known || !businessUploads.cleared) {
    return {
      closed: false,
      reason: businessUploads.reason || 'business_upload_state_unknown',
      businessUploads,
    };
  }
  const initialOutbox = await inspectUnattendedCheckpointOutboxAttempt(
    normalized.id,
    normalized.attemptId,
  );
  if (!initialOutbox.known) {
    return {
      closed: false,
      reason: initialOutbox.reason || 'outbox_state_unknown',
    };
  }
  if (initialOutbox.pendingCount !== 0) {
    // Keep the runner alive so its module can still flush the durable row.
    return {closed: false, reason: 'checkpoint_reports_pending'};
  }
  const taskId = buildUnattendedCaptureTaskId(normalized.id);
  const runnerInspection = await runUnattendedRunnerTabLifecycle(async () => {
    const current = await readUnattendedKeywordRunRequest();
    if (
      !current ||
      current.id !== normalized.id ||
      current.attemptId !== normalized.attemptId ||
      !isTerminalUnattendedRunStatus(current.status)
    ) {
      return {ok: false, reason: 'attempt_superseded'};
    }
    let tabs;
    try {
      tabs = await chrome.tabs.query({});
    } catch (error) {
      return {ok: false, reason: 'runner_tab_query_failed', error};
    }
    const assignedRunnerTabId = Number(current.runnerTabId);
    const isOwnedRunnerTab = (tab) =>
      isUnattendedRunnerTabForRequest(
        tab,
        normalized.id,
        normalized.attemptId,
      ) ||
      (
        Number.isFinite(assignedRunnerTabId) &&
        assignedRunnerTabId > 0 &&
        Number(tab?.id) === assignedRunnerTabId &&
        isLegacyUnattendedRunnerTabForRequest(tab, normalized.id)
      );
    let exactRunnerTabs = tabs.filter(isOwnedRunnerTab);
    if (closeOwnedRunnerTabs && exactRunnerTabs.length > 0) {
      try {
        for (const tab of exactRunnerTabs) {
          const tabId = Number(tab?.id);
          if (!Number.isFinite(tabId) || tabId <= 0) continue;
          const latestRequest = await readUnattendedKeywordRunRequest();
          if (
            !latestRequest ||
            latestRequest.id !== normalized.id ||
            latestRequest.attemptId !== normalized.attemptId ||
            !isTerminalUnattendedRunStatus(latestRequest.status)
          ) {
            return {ok: false, reason: 'attempt_superseded'};
          }
          let liveTab;
          try {
            liveTab = await chrome.tabs.get(tabId);
          } catch (error) {
            if (
              /no tab with id|not found|does not exist|invalid tab id/iu.test(
                String(error?.message || error || ''),
              )
            ) {
              continue;
            }
            throw error;
          }
          if (!isOwnedRunnerTab(liveTab)) {
            continue;
          }
          await chrome.tabs.remove(tabId);
        }
        const remainingTabs = await chrome.tabs.query({});
        exactRunnerTabs = remainingTabs.filter(isOwnedRunnerTab);
      } catch (error) {
        return {ok: false, reason: 'runner_tab_close_unconfirmed', error};
      }
    }
    return {ok: true, runnerTabs: exactRunnerTabs};
  });
  if (!runnerInspection.ok) {
    return {
      closed: false,
      reason: runnerInspection.reason,
      ...(runnerInspection.error ? {error: runnerInspection.error} : {}),
    };
  }
  const runnerTabs = runnerInspection.runnerTabs;

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.captureExecutionLock,
    STORAGE_KEYS.runtime,
  ]).catch((error) => ({__readError: error}));
  if (stored.__readError) {
    return {closed: false, reason: 'runtime_state_unknown', error: stored.__readError};
  }
  const rawLock = stored[STORAGE_KEYS.captureExecutionLock];
  const runtime =
    stored[STORAGE_KEYS.runtime] &&
    typeof stored[STORAGE_KEYS.runtime] === 'object'
      ? stored[STORAGE_KEYS.runtime]
      : {};
  const debugSession = captureDebugSessionManager?.getSessionByTaskId(taskId);
  const taskGroup = captureTaskTabGroupManager?.getTask(taskId);
  const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
  const owner = captureTaskOwnerCoordinator?.getOwner(taskId);
  const runtimeDebugTaskId = String(
    runtime.captureDebugSession?.taskId || '',
  ).trim();
  const runtimeDebugPresent = Boolean(runtimeDebugTaskId === taskId);
  // Re-read after every task-owned document has disappeared. At this point no
  // exact-attempt writer remains; a late durable row blocks proof rather than
  // being silently ignored.
  const outbox = await inspectUnattendedCheckpointOutboxAttempt(
    normalized.id,
    normalized.attemptId,
  );
  if (!outbox.known) {
    return {closed: false, reason: outbox.reason || 'outbox_state_unknown'};
  }

  const groupSourceTabId = resolveCaptureTaskTabId(taskGroup?.sourceTabId);
  const groupWorkerTabIds = Array.isArray(taskGroup?.workerTabIds)
    ? taskGroup.workerTabIds.map(resolveCaptureTaskTabId).filter(Boolean)
    : [];
  const detailTaskTabIds = new Set([
    ...pendingWorkerTabIds.map(resolveCaptureTaskTabId).filter(Boolean),
    ...groupWorkerTabIds,
  ]);
  const platformTaskTabCount = groupSourceTabId ? 1 : 0;
  const runnerTabCount = runnerTabs.length;
  const ownedTaskTabCount = new Set([
    ...runnerTabs.map((tab) => resolveCaptureTaskTabId(tab?.id)).filter(Boolean),
    ...(groupSourceTabId ? [groupSourceTabId] : []),
    ...detailTaskTabIds,
  ]).size;
  const state = {
    terminalLedgerConfirmed: true,
    runnerTabCount,
    platformTaskTabCount,
    detailTaskTabCount: detailTaskTabIds.size,
    ownedTaskTabCount,
    executionLockPresent: Boolean(rawLock),
    debugSessionPresent: Boolean(debugSession || runtimeDebugPresent),
    taskSessionPresent: Boolean(
      taskGroup ||
      captureTaskCleanupInProgress.has(taskId),
    ),
    taskOwnerPresent: Boolean(owner?.connected || owner?.abandoning),
    pendingCheckpointReportCount: outbox.pendingCount,
    ...businessUploads.state,
  };
  const closed = Boolean(
    state.runnerTabCount === 0 &&
    state.platformTaskTabCount === 0 &&
    state.detailTaskTabCount === 0 &&
    state.ownedTaskTabCount === 0 &&
    state.executionLockPresent === false &&
    state.debugSessionPresent === false &&
    state.taskSessionPresent === false &&
    state.taskOwnerPresent === false &&
    state.pendingCheckpointReportCount === 0 &&
    state.businessUploadEvidenceKnown === true &&
    state.streamingSyncDrainCompleted === true &&
    state.streamingSyncPendingCount === 0 &&
    state.streamingSyncActiveCount === 0 &&
    state.streamingSyncRemainingCount === 0 &&
    state.streamingSyncFailedCount === 0 &&
    state.streamingSyncSkippedCount === 0 &&
    state.streamingSyncBlocked === false &&
    state.streamingSyncCanceled === false
  );
  return {
    closed,
    reason: closed ? 'local_runtime_closed' : 'local_runtime_still_owned',
    request: normalized,
    taskId,
    itemIdentities,
    state,
  };
}

async function persistUnattendedLocalClosureEvidence(predicate) {
  if (
    !predicate?.closed ||
    !predicate.request ||
    !Array.isArray(predicate.itemIdentities) ||
    predicate.itemIdentities.length === 0
  ) {
    return {persisted: false, reason: predicate?.reason || 'predicate_not_closed'};
  }
  const expectedRequestId = String(predicate.request.id || '').trim();
  const expectedAttemptId = String(predicate.request.attemptId || '').trim();
  const persist = () => runUnattendedRunMutation(async () =>
    runTaskLedgerMutation(async () => {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.unattendedKeywordRunRequest,
        STORAGE_KEYS.taskLedger,
      ]);
      const current = normalizeUnattendedRunRequest(
        stored[STORAGE_KEYS.unattendedKeywordRunRequest],
      );
      if (
        !current ||
        current.id !== expectedRequestId ||
        current.attemptId !== expectedAttemptId ||
        !isTerminalUnattendedRunStatus(current.status)
      ) {
        return {persisted: false, reason: 'attempt_superseded'};
      }
      const currentItemIdentities =
        resolveUnattendedClosureItemIdentities(current);
      const expectedItemIdentityKeys = predicate.itemIdentities.map(identity =>
        `${identity.itemId}:${identity.itemAttemptId}:` +
          `${identity.attemptNumber}:${identity.assignmentRevision}`,
      );
      const currentItemIdentityKeys = currentItemIdentities.map(identity =>
        `${identity.itemId}:${identity.itemAttemptId}:` +
          `${identity.attemptNumber}:${identity.assignmentRevision}`,
      );
      if (
        currentItemIdentityKeys.length !== expectedItemIdentityKeys.length ||
        currentItemIdentityKeys.some(
          (identity, index) => identity !== expectedItemIdentityKeys[index],
        )
      ) {
        return {persisted: false, reason: 'item_attempt_identity_changed'};
      }
      const core = getUnattendedTaskCenterCore();
      const now = new Date().toISOString();
      const ledger = core?.normalizeTaskLedger
        ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
        : stored[STORAGE_KEYS.taskLedger];
      const runs = Array.isArray(ledger?.runs) ? [...ledger.runs] : [];
      const runIndex = runs.findIndex((run) =>
        String(run?.id || '').trim() === expectedRequestId,
      );
      const run = runIndex >= 0 ? runs[runIndex] : null;
      if (
        !run ||
        String(run.attemptId || '').trim() !== expectedAttemptId ||
        !isTerminalUnattendedRunStatus(run.status)
      ) {
        return {persisted: false, reason: 'terminal_ledger_mismatch'};
      }
      const existingClosures = Array.isArray(run.metadata?.localClosures)
        ? run.metadata.localClosures
        : run.metadata?.localClosure
          ? [run.metadata.localClosure]
          : [];
      const existingClosureKeys = new Set(
        existingClosures
          .filter(existing =>
            existing?.version === UNATTENDED_LOCAL_CLOSURE_EVIDENCE_VERSION &&
            String(existing.requestId || '').trim() === expectedRequestId &&
            String(existing.attemptId || '').trim() === expectedAttemptId,
          )
          .map(existing =>
            `${String(existing.itemId || '').trim()}:` +
              `${String(existing.itemAttemptId || '').trim()}:` +
              `${Number(existing.attemptNumber)}:` +
              Number(existing.assignmentRevision),
          ),
      );
      if (
        predicate.itemIdentities.every(identity => existingClosureKeys.has(
          `${identity.itemId}:${identity.itemAttemptId}:` +
            `${identity.attemptNumber}:${identity.assignmentRevision}`,
        ))
      ) {
        return {
          persisted: false,
          reason: 'already_persisted',
          evidence: existingClosures[0] || null,
          evidences: existingClosures,
        };
      }
      const snapshotRevision = Math.max(
        Math.max(0, Number(current.progressSeq) || 0),
        Math.max(0, Number(run.progressSeq) || 0),
      ) + 1;
      const evidences = Object.freeze(predicate.itemIdentities.map(identity =>
        Object.freeze({
          version: UNATTENDED_LOCAL_CLOSURE_EVIDENCE_VERSION,
          requestId: expectedRequestId,
          attemptId: expectedAttemptId,
          itemId: identity.itemId,
          itemAttemptId: identity.itemAttemptId,
          // The server fences safety handoff to each business item attempt,
          // which may differ from this browser task's local retry counter.
          attemptNumber: identity.attemptNumber,
          assignmentRevision: identity.assignmentRevision,
          snapshotRevision,
          terminalStatus: String(current.status || '').trim().toLowerCase(),
          terminalUpdatedAt: String(
            current.updatedAt || current.finishedAt || '',
          ),
          closedAt: now,
          ...predicate.state,
        }),
      ));
      const evidence = evidences[0];
      const nextRequest = {
        ...current,
        localClosureEvidence: evidence,
        localClosureEvidences: evidences,
        progressSeq: snapshotRevision,
        heartbeatAt: now,
        updatedAt: now,
      };
      runs[runIndex] = {
        ...run,
        progressSeq: snapshotRevision,
        heartbeatAt: now,
        updatedAt: now,
        metadata: {
          ...(run.metadata && typeof run.metadata === 'object'
            ? run.metadata
            : {}),
          localClosure: evidence,
          localClosures: evidences,
        },
      };
      const nextLedger = {
        ...(ledger && typeof ledger === 'object' ? ledger : {}),
        runs,
        updatedAt: now,
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.unattendedKeywordRunRequest]: nextRequest,
        [STORAGE_KEYS.taskLedger]: nextLedger,
      });
      return {
        persisted: true,
        reason: 'local_closure_persisted',
        evidence,
        evidences,
      };
    }),
  );
  return await runAuthoritativeControlStorageMutation(persist);
}

async function reconcileUnattendedLocalClosureEvidence({
  expectedRequestId = '',
  expectedAttemptId = '',
  closeOwnedRunnerTabs = true,
} = {}) {
  const request = await readUnattendedKeywordRunRequest();
  if (
    !request ||
    (expectedRequestId && request.id !== String(expectedRequestId)) ||
    (expectedAttemptId && request.attemptId !== String(expectedAttemptId))
  ) {
    return {persisted: false, reason: 'attempt_superseded'};
  }
  const predicate = await inspectUnattendedLocalClosurePredicate(request, {
    closeOwnedRunnerTabs,
  });
  if (!predicate.closed) {
    return {persisted: false, reason: predicate.reason, predicate};
  }
  return await persistUnattendedLocalClosureEvidence(predicate);
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
    await releaseCaptureExecutionLock(lockSnapshot.id);
  }
  return relayedCount;
}

async function cancelUnattendedKeywordRunFromControl({
  requestId = '',
  message = '用户手动中止当前采集任务',
  tabId = null,
} = {}) {
  const requestedId = String(requestId || '').trim();
  const request = await readUnattendedKeywordRunRequest();
  if (requestedId && request?.id !== requestedId) {
    const archivedRequest =
      await readArchivedUnattendedKeywordRunRequest(requestedId);
    if (archivedRequest) {
      await removeArchivedUnattendedKeywordRunRequest(requestedId);
      return {
        accepted: true,
        reason: 'results_kept',
        request: archivedRequest,
        plan: await readUnattendedKeywordPlan(),
        relayedCount: 0,
      };
    }
    const ledger = await readTaskLedger();
    const historicalRun = (Array.isArray(ledger?.runs) ? ledger.runs : []).find(
      (run) => String(run?.id || '').trim() === requestedId,
    );
    const alreadyTerminal = isTerminalUnattendedRunStatus(
      historicalRun?.status,
    );
    return {
      accepted: alreadyTerminal,
      reason: alreadyTerminal ? 'already_terminal' : 'request_mismatch',
      request: historicalRun || request || null,
      plan: await readUnattendedKeywordPlan(),
      relayedCount: 0,
    };
  }
  if (
    request &&
    isTerminalUnattendedRunStatus(request.status) &&
    request.status !== 'needs_action'
  ) {
    const terminalCleanup = await cleanupTerminalUnattendedRuntime(
      request,
      [tabId],
    );
    const reconciledTerminalRequest = terminalCleanup.request || request;
    const relayedCount = terminalCleanup.relayedCount;
    if (isRetryableUnattendedRunRequest(reconciledTerminalRequest)) {
      const now = new Date().toISOString();
      const expectedAttemptId = String(
        reconciledTerminalRequest.attemptId || '',
      ).trim();
      const persistDismissal = () => runUnattendedRunMutation(async () => {
        const current = await readUnattendedKeywordRunRequest();
        if (
          !current ||
          current.id !== reconciledTerminalRequest.id ||
          current.attemptId !== expectedAttemptId ||
          !isRetryableUnattendedRunRequest(current)
        ) {
          return null;
        }
        const dismissed = {
          ...current,
          recoveryDismissedAt: now,
          recoveryDismissedMessage: message,
          updatedAt: now,
        };
        await chrome.storage.local.set({
          [STORAGE_KEYS.unattendedKeywordRunRequest]: dismissed,
        });
        return dismissed;
      });
      const dismissedRequest =
        await runAuthoritativeControlStorageMutation(persistDismissal);
      if (!dismissedRequest) {
        return {
          accepted: false,
          reason: 'attempt_mismatch',
          request: await readUnattendedKeywordRunRequest(),
          plan: await readUnattendedKeywordPlan(),
          relayedCount,
        };
      }
      await removeArchivedUnattendedKeywordRunRequest(request.id);
      scheduleCloudTaskAgentSync('unattended_recovery_dismissed');
      return {
        accepted: true,
        reason: 'results_kept',
        request: dismissedRequest,
        plan: await readUnattendedKeywordPlan(),
        relayedCount,
      };
    }
    return {
      accepted: true,
      reason: 'already_terminal',
      request: reconciledTerminalRequest,
      plan: await readUnattendedKeywordPlan(),
      relayedCount,
    };
  }
  if (!request) {
    return {
      accepted: false,
      reason: 'not_found',
      request: null,
      plan: await readUnattendedKeywordPlan(),
      relayedCount: 0,
    };
  }

  const progress = normalizeUnattendedRunProgress(
    request.progress,
    request.message,
  );
  const explicitTabId = Number(tabId);
  const progressRunnerTabId = Number(progress?.runnerTabId);
  // 状态切换前保留旧锁和平台页身份，确保在 Debug 尚未建立的导航阶段
  // 也可以精确停止，而不会误伤随后启动的新任务。
  const lockSnapshot = await snapshotUnattendedKeywordPlanLock();
  const canceledRequest = await cancelUnattendedKeywordRunRequest(message, {
    requestId: requestedId,
  });
  if (!canceledRequest) {
    return {
      accepted: false,
      reason: 'request_mismatch',
      request,
      plan: await readUnattendedKeywordPlan(),
      relayedCount: 0,
    };
  }
  const relayedCount = await cancelAndReleaseUnattendedExecutionTargets(
    lockSnapshot,
    [explicitTabId, progressRunnerTabId],
  );

  const now = new Date();
  let nextPlan;
  if (canceledRequest.cloudAssigned === true) {
    // 云端一次性任务与本地定时计划互不覆盖。停止云任务后只恢复本地
    // 计划调度，不把这次取消写成本地计划的运行结果。
    nextPlan = await reconcileUnattendedKeywordPlanSchedule({launchDue: true});
  } else {
    const plan = await readUnattendedKeywordPlan();
    nextPlan = await saveUnattendedKeywordPlan(
      {
        ...plan,
        lastRunAt: now.toISOString(),
        lastRunStatus: 'canceled',
        lastRunMessage: message,
        lastRunProgress: progress,
        nextRunAt: '',
      },
      {recomputeNext: true, from: buildScheduleReferenceAfterDate(now)},
    );
  }

  return {
    accepted: true,
    reason: 'canceled',
    request: canceledRequest,
    plan: nextPlan,
    relayedCount,
  };
}

async function cleanupDisabledUnattendedKeywordPlanRuntime() {
  const message = '无人值守计划已关闭，已取消未完成任务';
  // 状态切换前捕获旧锁和平台页。列表采集阶段 progress 可能尚未带 runnerTabId，
  // 若先释放锁再取消，旧 content capture 会继续与下一任务并行。
  const request = await readUnattendedKeywordRunRequest();
  // 云端一次性下发任务与本地定时计划相互独立。关闭本地计划不能顺带
  // 取消后台已分配并正在执行的任务。
  if (!request || request.cloudAssigned === true) {
    return;
  }
  const progress = normalizeUnattendedRunProgress(
    request?.progress,
    request?.message,
  );
  const lockSnapshot = await snapshotUnattendedKeywordPlanLock();
  const canceledRequest = await cancelUnattendedKeywordRunRequest(message, {
    requestId: String(request.id || ''),
    attemptId: String(request.attemptId || ''),
    localOnly: true,
    cancelSource: 'plan_disabled',
    cancelReason: 'plan_disabled',
    errorCode: 'PLAN_DISABLED',
  });
  // A cloud assignment may replace the local request between the read above
  // and this serialized mutation. Only tear down targets when that exact
  // local request was canceled; otherwise the new cloud task owns the lock.
  if (!canceledRequest) {
    return;
  }
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
    confirmCloudScope = false,
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
  if (confirmCloudScope) {
    const credential = await readCloudTaskAgentCredential();
    await confirmCloudTaskAgentPlanScope(credential.id);
  }
  scheduleCloudTaskAgentSync('unattended_plan_saved');
  if (!nextPlan.enabled) {
    await cleanupDisabledUnattendedKeywordPlanRuntime();
  }
  return nextPlan;
}

async function clearUnattendedKeywordPlan({confirmCloudScope = false} = {}) {
  const currentPlan = await readUnattendedKeywordPlan();
  await saveUnattendedKeywordPlan(
    {
      ...currentPlan,
      configured: false,
      enabled: false,
      keywords: [],
      nextRunAt: '',
    },
    {
      recomputeNext: false,
      preserveRunState: false,
      confirmCloudScope: false,
    },
  );
  await chrome.storage.local.remove(STORAGE_KEYS.unattendedKeywordPlan);
  await syncUnattendedKeywordAlarm({});
  if (confirmCloudScope) {
    const credential = await readCloudTaskAgentCredential();
    await confirmCloudTaskAgentPlanScope(credential.id);
  }
  scheduleCloudTaskAgentSync('unattended_plan_deleted');
  return {configured: false, enabled: false};
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
    captureTaskId: String(value.captureTaskId || '').trim(),
    captureTaskAttemptId: String(value.captureTaskAttemptId || '').trim(),
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

async function bindCaptureExecutionLockToTask(
  taskId,
  sourceTabId,
  {
    allowUnattendedRebind = false,
    attemptId = '',
    expectedLockId = '',
    expectedHolderId = '',
    expectedHolderDocumentId = '',
  } = {},
) {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  const normalizedSourceTabId = resolveCaptureTaskTabId(sourceTabId);
  if (!normalizedTaskId || !normalizedSourceTabId) return null;

  return await runCaptureExecutionLockOperation(async () => {
    const activeLock = await readActiveCaptureExecutionLockUnsafe();
    if (!activeLock) {
      return activeLock;
    }
    const unattendedRebind = Boolean(
      allowUnattendedRebind &&
        String(activeLock.owner || '') === 'unattended_keyword_plan',
    );
    if (
      unattendedRebind &&
      ((expectedLockId && activeLock.id !== String(expectedLockId)) ||
        (expectedHolderId &&
          String(activeLock.holderId || '') !== String(expectedHolderId)) ||
        (expectedHolderDocumentId &&
          String(activeLock.holderDocumentId || '') !==
            String(expectedHolderDocumentId)))
    ) {
      // The lock was transferred after BEGIN's preflight. Returning the new
      // lock here is ambiguous when it already carries the same stable task
      // and attempt binding: the old BEGIN could mistake that lock for its own
      // successful bind. Fail the compare-and-set explicitly instead.
      return null;
    }
    if (
      !unattendedRebind &&
      (Number(activeLock.holderTabId) !== normalizedSourceTabId ||
        (activeLock.captureTaskId &&
          activeLock.captureTaskId !== normalizedTaskId))
    ) {
      return activeLock;
    }
    if (activeLock.captureTaskId === normalizedTaskId) {
      if (
        !unattendedRebind ||
        (Number(activeLock.holderTabId) === normalizedSourceTabId &&
          String(activeLock.captureTaskAttemptId || '').trim() ===
            normalizedAttemptId)
      ) {
        return activeLock;
      }
    }

    const boundLock = {
      ...activeLock,
      captureTaskId: normalizedTaskId,
      ...(unattendedRebind
        ? {
            holderTabId: normalizedSourceTabId,
            captureTaskAttemptId: normalizedAttemptId,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: boundLock,
    });
    return boundLock;
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
  const release = () => runCaptureExecutionLockOperation(async () => {
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
    if (requireHolder) {
      const normalizedHolderId = String(holderId || '');
      const normalizedDocumentId = String(holderDocumentId || '');
      // holderId 是侧栏文档启动时生成的随机凭证。Chrome 在扩展更新、
      // service worker 重启等场景下可能改变 MessageSender.documentId；只要
      // holderId 仍匹配，就允许原侧栏收口，避免后台留下无法释放的幽灵锁。
      if (activeLock.holderId) {
        if (activeLock.holderId !== normalizedHolderId) {
          return false;
        }
      } else if (
        activeLock.holderDocumentId &&
        activeLock.holderDocumentId !== normalizedDocumentId
      ) {
        return false;
      }
    }
    await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
    return true;
  });
  return await runAuthoritativeControlStorageMutation(release);
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

function buildUnattendedRunnerUrl(requestId, attemptId) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  if (!normalizedRequestId || !normalizedAttemptId) {
    const error = new Error('无人值守运行页缺少任务执行轮次');
    error.code = 'UNATTENDED_ATTEMPT_REQUIRED';
    throw error;
  }
  const url = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
  url.searchParams.set(UNATTENDED_RUNNER_QUERY_KEY, normalizedRequestId);
  url.searchParams.set(
    UNATTENDED_RUNNER_ATTEMPT_QUERY_KEY,
    normalizedAttemptId,
  );
  return url.toString();
}

function buildTargetedPostRunnerUrl(requestId, attemptId = '') {
  const url = new URL(chrome.runtime.getURL(SIDEBAR_PAGE_PATH));
  url.searchParams.set(TARGETED_POST_RUNNER_QUERY_KEY, requestId);
  if (attemptId) {
    url.searchParams.set(
      TARGETED_POST_RUNNER_ATTEMPT_QUERY_KEY,
      attemptId,
    );
  }
  return url.toString();
}

function normalizeConcreteWindowId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const windowId = Number(value);
  return Number.isSafeInteger(windowId) && windowId > 0 ? windowId : null;
}

function isMissingBrowserWindowError(error) {
  return /no window with id/i.test(String(error?.message || error || ''));
}

async function createRunnerTab(createOptions, concreteWindowId) {
  if (concreteWindowId === null) {
    return await chrome.tabs.create(createOptions);
  }
  try {
    return await chrome.tabs.create({
      ...createOptions,
      windowId: concreteWindowId,
    });
  } catch (error) {
    if (!isMissingBrowserWindowError(error)) {
      throw error;
    }
    return await chrome.tabs.create(createOptions);
  }
}

async function openTargetedPostRunnerTab(
  requestId,
  {windowId = null, attemptId = ''} = {},
) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  if (!normalizedRequestId || !normalizedAttemptId) {
    const error = new Error('定向作品运行页缺少任务执行轮次');
    error.code = 'TARGETED_POST_ATTEMPT_REQUIRED';
    throw error;
  }
  const runnerUrl = buildTargetedPostRunnerUrl(
    normalizedRequestId,
    normalizedAttemptId,
  );
  const sidebarUrl = chrome.runtime.getURL(SIDEBAR_PAGE_PATH);
  const allTabs = await chrome.tabs.query({});
  const existingRunner = allTabs.find((tab) => {
    const currentUrl = String(tab?.url || '');
    if (!currentUrl.startsWith(`${sidebarUrl}?`)) return false;
    try {
      const parsed = new URL(currentUrl);
      return (
        parsed.searchParams.get(TARGETED_POST_RUNNER_QUERY_KEY) ===
          normalizedRequestId &&
        parsed.searchParams.get(TARGETED_POST_RUNNER_ATTEMPT_QUERY_KEY) ===
          normalizedAttemptId
      );
    } catch (_error) {
      return false;
    }
  });
  if (existingRunner?.id) {
    return await chrome.tabs.update(existingRunner.id, {
      active: true,
      autoDiscardable: false,
    });
  }
  const createOptions = {url: runnerUrl, active: true};
  const concreteWindowId = normalizeConcreteWindowId(windowId);
  const createdRunner = await createRunnerTab(createOptions, concreteWindowId);
  if (!createdRunner?.id) {
    return createdRunner;
  }
  return await chrome.tabs.update(createdRunner.id, {
    autoDiscardable: false,
  });
}

async function openUnattendedRunnerTab(
  requestId,
  {windowId = null, attemptId = ''} = {},
) {
  return await runUnattendedRunnerTabLifecycle(async () => {
    const runnerUrl = buildUnattendedRunnerUrl(requestId, attemptId);
    const allTabs = await chrome.tabs.query({});
    const existingRunner = allTabs.find((tab) =>
      isUnattendedRunnerTabForRequest(tab, requestId, attemptId),
    );

    if (existingRunner?.id) {
      return await chrome.tabs.update(existingRunner.id, {
        url: runnerUrl,
        active: true,
        autoDiscardable: false,
      });
    }

    const createOptions = {
      url: runnerUrl,
      active: true,
    };
    const concreteWindowId = normalizeConcreteWindowId(windowId);
    const createdRunner = await createRunnerTab(createOptions, concreteWindowId);
    if (!createdRunner?.id) {
      return createdRunner;
    }
    return await chrome.tabs.update(createdRunner.id, {
      autoDiscardable: false,
    });
  });
}

async function createUnattendedKeywordRunRequest(
  plan,
  {
    reason = 'alarm',
    requestId = '',
    cloudCommandId = '',
    cloudAssigned = false,
    executionMode = '',
    orchestrationContext = null,
    checkpoint = null,
  } = {},
) {
  return await runUnattendedRunMutation(async () => {
    const existing = await readUnattendedKeywordRunRequest();
    if (existing && !isTerminalUnattendedRunStatus(existing.status)) {
      return existing;
    }
    if (isRetryableUnattendedRunRequest(existing)) {
      await archiveUnattendedKeywordRunRequest(existing);
    }
    const cloudCredential = await readCloudTaskAgentCredential();
    const now = new Date().toISOString();
    const normalizedOrchestrationContext =
      normalizeOrchestrationExecutionContext(orchestrationContext);
    const executionCopy = getUnattendedExecutionCopy({
      executionMode,
      orchestrationContext: normalizedOrchestrationContext,
    });
    const request = {
      schemaVersion: UNATTENDED_RUN_SCHEMA_VERSION,
      id: String(requestId || '').trim() || createUuid(),
      attemptId: createUuid(),
      attemptNumber: 1,
      progressSeq: 0,
      recoveryCount: 0,
      type: 'keyword_batch',
      status: 'pending',
      reason,
      cloudCommandId: String(cloudCommandId || '').trim(),
      cloudAssigned: cloudAssigned === true,
      executionMode: executionCopy.executionMode,
      ...(normalizedOrchestrationContext
        ? {orchestrationContext: normalizedOrchestrationContext}
        : {}),
      cloudAgentScopeId: String(cloudCredential.id || ''),
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      businessProgressAt: now,
      planSnapshot: normalizeUnattendedKeywordPlan(plan),
      ...(checkpoint && typeof checkpoint === 'object'
        ? {checkpoint: JSON.parse(JSON.stringify(checkpoint))}
        : {}),
      progress: null,
      error: null,
      message: `已创建${executionCopy.taskLabel}，等待运行页领取`,
    };
    await persistUnattendedRunMutation(request, {
      event: {
        type: 'created',
        message: `已创建${executionCopy.taskLabel}`,
        at: now,
      },
    });
    if (!cloudAssigned && existing?.status === 'needs_action') {
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
    const executionCopy = getUnattendedExecutionCopy(current);
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
              message: `${executionCopy.runnerLabel}已连接`,
              at: now,
            },
    });
    return nextRequest;
  });
}

async function claimUnattendedKeywordRun({
  requestId = '',
  attemptId = '',
  requireAttempt = false,
  senderTabId = null,
  senderDocumentId = '',
  holderId = '',
} = {}) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (!request || (requestId && request.id !== requestId)) {
      return {accepted: false, reason: 'not_found', data: null};
    }
    const normalizedAttemptId = String(attemptId || '').trim();
    if (requireAttempt && !normalizedAttemptId) {
      return {accepted: false, reason: 'runner_attempt_required', data: null};
    }
    if (normalizedAttemptId && request.attemptId !== normalizedAttemptId) {
      return {accepted: false, reason: 'attempt_superseded', data: null};
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

    const normalizedHolderId = String(holderId || '').trim();
    const normalizedSenderDocumentId = String(senderDocumentId || '').trim();
    if (!normalizedHolderId || !normalizedSenderDocumentId) {
      return {
        accepted: false,
        reason: 'missing_lock_holder',
        data: request,
        lock: null,
      };
    }

    // Reserve the unattended execution lock at claim time, before the runner
    // can start a stable Debug task. This closes the window where a canceled
    // or lockless runner could create browser resources and only acquire the
    // real capture lock later inside the keyword batch.
    const transferredLock =
      await transferOrReserveUnattendedCaptureExecutionLock({
        holderId: normalizedHolderId,
        holderDocumentId: normalizedSenderDocumentId,
        holderTabId: isSameRunnerResume
          ? request?.progress?.runnerTabId
          : normalizedSenderTabId,
      });
    if (!transferredLock) {
      const blockedAt = new Date().toISOString();
      const executionCopy = getUnattendedExecutionCopy(request);
      const blockedMessage = `检测到其他采集任务已占用执行锁，已阻止${executionCopy.taskLabel}并行恢复；请等待当前任务结束后在任务中心重试`;
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
    if (isSameRunnerResume) {
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
      await releaseUnattendedCaptureTaskResourcesForRecovery(transferredLock, {
        reason: 'unattended_runner_resumed',
        request,
      });
    }

    const claimedAt = new Date().toISOString();
    const executionCopy = getUnattendedExecutionCopy(request);
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
        : String(
            request.message || `${executionCopy.runnerLabel}已领取任务`,
          ),
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
  const result = await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (!request || !requestId || request.id !== requestId) {
      return {accepted: false, reason: 'not_found', data: null};
    }
    const safePatch =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const hasCheckpoint =
      safePatch.checkpoint &&
      typeof safePatch.checkpoint === 'object' &&
      !Array.isArray(safePatch.checkpoint);
    if (!attemptId || request.attemptId !== attemptId) {
      const previousAttemptCheckpointHandoff = Boolean(
        hasCheckpoint &&
          String(request.previousAttemptId || '') === String(attemptId || '') &&
          !isTerminalUnattendedRunStatus(request.status) &&
          buildUnattendedBusinessProgressFingerprint(safePatch.checkpoint) !==
            buildUnattendedBusinessProgressFingerprint(
              request.checkpoint || null,
            ) &&
          !isLegacyUnattendedCheckpointRegression(
            safePatch.checkpoint,
            request.checkpoint,
          ),
      );
      if (previousAttemptCheckpointHandoff) {
        const now = new Date().toISOString();
        const milestoneAdvanced =
          buildUnattendedRecoveryMilestoneFingerprint(safePatch.checkpoint) !==
          buildUnattendedRecoveryMilestoneFingerprint(
            request.checkpoint || null,
          );
        const nextRequest = {
          ...request,
          checkpoint: safePatch.checkpoint,
          ...(safePatch.counts && typeof safePatch.counts === 'object'
            ? {counts: safePatch.counts}
            : {}),
          ...(safePatch.summary && typeof safePatch.summary === 'object'
            ? {summary: safePatch.summary}
            : {}),
          progressSeq: Math.max(
            Math.max(0, Number(request.progressSeq) || 0) + 1,
            Math.max(0, Number(safePatch.progressSeq) || 0),
          ),
          businessProgressAt: resolveUnattendedBusinessProgressAt({
            suppliedAt: safePatch.businessProgressAt,
            currentAt: request.businessProgressAt,
            now,
            hasProgressSequence: true,
          }),
          recoveryCount: milestoneAdvanced
            ? 0
            : Math.max(0, Number(request.recoveryCount) || 0),
          recoveryLaunchFailures: milestoneAdvanced
            ? 0
            : Math.max(0, Number(request.recoveryLaunchFailures) || 0),
          updatedAt: now,
        };
        await persistUnattendedRunMutation(nextRequest, {
          previousRequest: request,
          event: {
            type: 'previous_attempt_checkpoint_handoff',
            message: '已合并上一执行 attempt 尚未落盘的关键词检查点',
            at: now,
          },
        });
        return {
          accepted: true,
          reason: 'checkpoint_handoff',
          data: nextRequest,
        };
      }
      return {accepted: false, reason: 'attempt_mismatch', data: request};
    }
    if (isTerminalUnattendedRunStatus(request.status)) {
      return {accepted: false, reason: 'terminal', data: request};
    }

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
    // 恢复后的 runner 会先重放已保存的 progress/checkpoint。语义变化可
    // 刷新业务时钟，但只有关键词结算等持久检查点里程碑才能归还“连续恢复”
    // 预算；仅阶段切换、时间戳变化、心跳或同一检查点重试均不能清零预算。
    const progressAdvanced =
      hasProgress &&
      buildUnattendedBusinessProgressFingerprint(safePatch.progress) !==
        buildUnattendedBusinessProgressFingerprint(request.progress || null);
    const checkpointAdvanced =
      hasCheckpoint &&
      buildUnattendedBusinessProgressFingerprint(safePatch.checkpoint) !==
        buildUnattendedBusinessProgressFingerprint(request.checkpoint || null);
    const hasBusinessProgress = progressAdvanced || checkpointAdvanced;
    const recoveryMilestoneAdvanced =
      hasCheckpoint &&
      buildUnattendedRecoveryMilestoneFingerprint(safePatch.checkpoint) !==
        buildUnattendedRecoveryMilestoneFingerprint(request.checkpoint || null);
    let nextProgressSeq = request.progressSeq;
    if (hasProgress || hasCheckpoint) {
      const suppliedProgressSeq = Number(safePatch.progressSeq);
      const staleSequence =
        Number.isFinite(suppliedProgressSeq) &&
        suppliedProgressSeq <= request.progressSeq;
      const monotonicCheckpointHandoff = Boolean(
        staleSequence &&
          hasCheckpoint &&
          checkpointAdvanced &&
          !isLegacyUnattendedCheckpointRegression(
            safePatch.checkpoint,
            request.checkpoint,
          ),
      );
      if (
        (staleSequence && !monotonicCheckpointHandoff) ||
        (!Number.isFinite(suppliedProgressSeq) &&
          hasCheckpoint &&
          isLegacyUnattendedCheckpointRegression(
            safePatch.checkpoint,
            request.checkpoint,
          ))
      ) {
        return {accepted: false, reason: 'stale_progress', data: request};
      }
      nextProgressSeq = monotonicCheckpointHandoff
        ? Math.max(0, Number(request.progressSeq) || 0) + 1
        : Number.isFinite(suppliedProgressSeq)
          ? Math.floor(suppliedProgressSeq)
        : hasProgress
          ? request.progressSeq + 1
          : request.progressSeq;
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
    } else if (
      hasProgress &&
      !String(safePatch.progress?.phase || '').startsWith('waiting_')
    ) {
      // 收到真实执行阶段后，清掉上一段恢复等待。否则任务中心会在任务已经
      // 前进时继续展示一个过期倒计时。
      waitUntil = '';
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
      businessProgressAt: hasBusinessProgress
        ? resolveUnattendedBusinessProgressAt({
            suppliedAt: safePatch.businessProgressAt,
            currentAt: request.businessProgressAt,
            now,
            hasProgressSequence: Number.isFinite(Number(safePatch.progressSeq)),
          })
        : request.businessProgressAt,
      recoveryCount: recoveryMilestoneAdvanced
        ? 0
        : Math.max(0, Number(request.recoveryCount) || 0),
      recoveryLaunchFailures: recoveryMilestoneAdvanced
        ? 0
        : Math.max(0, Number(request.recoveryLaunchFailures) || 0),
      recoveryWaitUntil: waitUntil,
      updatedAt: now,
    };
    if (isTerminalUnattendedRunStatus(nextStatus)) {
      nextRequest.finishedAt = String(safePatch.finishedAt || now);
      nextRequest.recoveryPendingLaunch = false;
      nextRequest.recoveryWaitUntil = '';
      nextRequest.wakeGraceUntil = '';
      nextRequest.progress = {
        ...(nextRequest.progress && typeof nextRequest.progress === 'object'
          ? nextRequest.progress
          : {}),
        waitUntil: '',
        remainingMs: null,
      };
    }
    delete nextRequest.requestId;

    const statusChanged = nextStatus !== request.status;
    const persisted = await persistUnattendedRunMutation(nextRequest, {
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
    return {
      accepted: true,
      reason: 'updated',
      data: persisted?.request || nextRequest,
      previousRunnerTabId: request.runnerTabId,
    };
  });
  if (
    result?.accepted &&
    isTerminalUnattendedRunStatus(result.data?.status)
  ) {
    const terminalCleanup = await cleanupTerminalUnattendedRuntime(
      result.data,
      [result.previousRunnerTabId, result.data?.progress?.runnerTabId],
    );
    return {
      ...result,
      data: terminalCleanup.request || result.data,
    };
  }
  return result;
}

async function launchUnattendedKeywordRun(
  plan,
  {
    reason = 'alarm',
    requestId = '',
    cloudCommandId = '',
    cloudAssigned = false,
    executionMode = '',
    orchestrationContext = null,
    checkpoint = null,
  } = {},
) {
  const normalizedPlan = normalizeUnattendedKeywordPlan(plan);
  if (!normalizedPlan.enabled || normalizedPlan.keywords.length === 0) {
    return null;
  }

  const request = await createUnattendedKeywordRunRequest(normalizedPlan, {
    reason,
    requestId,
    cloudCommandId,
    cloudAssigned,
    executionMode,
    orchestrationContext,
    checkpoint,
  });
  if (requestId && request.id !== requestId) {
    return null;
  }
  try {
    const platformTab = await activateOrCreatePlatformTab(normalizedPlan.platform);
    const runnerTab = await openUnattendedRunnerTab(request.id, {
      windowId: platformTab?.windowId,
      attemptId: request.attemptId,
    });
    await bindUnattendedRunnerTab(request, runnerTab?.id);
  } catch (error) {
    const executionCopy = getUnattendedExecutionCopy(request);
    await markUnattendedRunRequestStale(
      request,
      `创建${executionCopy.runnerLabel}失败：${error?.message || '未知错误'}`,
    );
    throw error;
  }
  return request;
}

function getUnattendedRecoveryBlockReason(request) {
  const checkpointResults = Array.isArray(request?.checkpoint?.keywordResults)
    ? request.checkpoint.keywordResults
    : [];
  const structuredBlock = [
    request?.error,
    request?.progress,
    ...checkpointResults,
  ].find((entry) => {
    const entryCode = String(
      entry?.errorCode ||
        entry?.error_code ||
        entry?.code ||
        entry?.error?.code ||
        '',
    )
      .trim()
      .toUpperCase();
    if (entryCode === 'DOUYIN_SEARCH_SERVICE_ABNORMAL') {
      return false;
    }
    return Boolean(
      entry?.securityBlocked === true ||
        entry?.security_blocked === true ||
        entry?.requiresManualAction === true ||
        entry?.requires_manual_action === true ||
        entry?.error?.securityBlocked === true ||
        entry?.error?.requiresManualAction === true ||
        [
          'PLATFORM_SAFETY_BLOCK',
          'SECURITY_VERIFICATION_REQUIRED',
        ].includes(entryCode),
    );
  });
  const structuredCode = String(
    structuredBlock?.errorCode ||
      structuredBlock?.error_code ||
      structuredBlock?.code ||
      structuredBlock?.error?.code ||
      '',
  )
    .trim()
    .toUpperCase();
  const structuredError =
    structuredBlock?.error && typeof structuredBlock.error === 'object'
      ? structuredBlock.error
      : null;
  const structuredMessage = String(
    structuredError?.message ||
      (typeof structuredBlock?.error === 'string'
        ? structuredBlock.error
        : '') ||
      structuredBlock?.message ||
      '',
  ).trim();
  if (structuredBlock) {
    return {
      code: structuredCode || 'UNATTENDED_RECOVERY_BLOCKED',
      category: String(
        structuredBlock?.errorCategory ||
          structuredBlock?.error_category ||
          structuredBlock?.category ||
          structuredBlock?.error?.category ||
          '',
      ).trim(),
      message:
        structuredMessage || '任务已进入人工处理状态，已停止自动恢复',
      securityBlocked: Boolean(
        structuredBlock?.securityBlocked === true ||
          structuredBlock?.security_blocked === true ||
          structuredBlock?.error?.securityBlocked === true,
      ),
      requiresManualAction: true,
      retryable: false,
    };
  }

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
    return null;
  }
  if (/login|auth/.test(code) || /登录/.test(text)) {
    return {
      code: String(request?.error?.code || 'UNATTENDED_RECOVERY_BLOCKED'),
      message: '登录状态已失效，需要用户重新登录后继续',
      requiresManualAction: true,
      retryable: false,
    };
  }
  return {
    code: String(request?.error?.code || 'UNATTENDED_RECOVERY_BLOCKED'),
    message: '平台触发安全验证或账号限制，已停止自动重试',
    securityBlocked: true,
    requiresManualAction: true,
    retryable: false,
  };
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
      const runnerTab = await chrome.tabs.get(runnerTabId);
      if (runnerTab?.discarded === true) {
        return {healthy: false, reason: 'runner_tab_discarded', runnerTab};
      }
      if (runnerTab?.frozen === true) {
        return {healthy: false, reason: 'runner_tab_frozen', runnerTab};
      }
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

async function wakeFrozenUnattendedRunnerTab(request, runnerTab = null) {
  const runnerTabId = Number(request?.runnerTabId);
  if (!Number.isFinite(runnerTabId) || runnerTabId <= 0) {
    return {woken: false, reason: 'runner_tab_missing', request};
  }

  let resolvedRunnerTab = runnerTab;
  try {
    if (!resolvedRunnerTab || Number(resolvedRunnerTab.id) !== runnerTabId) {
      resolvedRunnerTab = await chrome.tabs.get(runnerTabId);
    }
    if (resolvedRunnerTab?.discarded === true) {
      return {woken: false, reason: 'runner_tab_discarded', request};
    }

    const windowId = Number(resolvedRunnerTab?.windowId);
    let restoreTabId = null;
    if (Number.isFinite(windowId) && windowId >= 0) {
      try {
        const activeTabs = await chrome.tabs.query({
          active: true,
          windowId,
        });
        const previousActiveTab = activeTabs.find(
          (tab) =>
            Number.isFinite(Number(tab?.id)) &&
            Number(tab.id) > 0 &&
            Number(tab.id) !== runnerTabId,
        );
        restoreTabId = previousActiveTab ? Number(previousActiveTab.id) : null;
      } catch {
        restoreTabId = null;
      }
    }

    // Chromium 会在 tab 被激活时解除 frozen。这里先唤醒原 runner，
    // 再恢复用户原本正在看的页面；不创建新 attempt，也不重跑当前关键词。
    await chrome.tabs.update(runnerTabId, {
      active: true,
      autoDiscardable: false,
    });
    if (restoreTabId) {
      try {
        await chrome.tabs.update(restoreTabId, {active: true});
      } catch {
        // runner 已经被唤醒。恢复用户原标签失败不应触发整段任务重跑。
      }
    }

    const protectedRequest = await applyUnattendedWakeGrace(
      request,
      'runner_tab_frozen',
    );
    return {
      woken: true,
      reason: 'runner_tab_woken',
      request: protectedRequest || request,
    };
  } catch (error) {
    return {
      woken: false,
      reason: 'runner_tab_wake_failed',
      request,
      error,
    };
  }
}

function formatUnattendedRecoveryReason(reason, request = null) {
  const executionCopy = getUnattendedExecutionCopy(request || {});
  const messages = {
    claim_timeout: '运行页未在规定时间内领取任务',
    runner_tab_closed: '运行页已被关闭',
    runner_tab_missing: '运行页已不存在',
    runner_tab_discarded: `浏览器已回收${executionCopy.runnerLabel}`,
    runner_tab_frozen: `浏览器已暂停${executionCopy.runnerLabel}`,
    runner_tab_wake_failed: `浏览器未能唤醒${executionCopy.runnerLabel}`,
    runner_heartbeat_stale: '运行页心跳中断',
    business_progress_stalled: '采集业务长时间没有新进展',
    runner_owner_disconnected: `${executionCopy.runnerLabel}连接已更换`,
    debug_target_closed: '浏览器替换了采集页面',
    source_tab_replace_failed: '浏览器替换页面后接管需要重建',
  };
  return (
    messages[String(reason || '')] || `${executionCopy.taskLabel}运行异常`
  );
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
      progress: {
        ...(current.progress && typeof current.progress === 'object'
          ? current.progress
          : {}),
        phase: 'waiting_capture_slot',
        waitUntil,
        remainingMs: UNATTENDED_SUPERVISOR_LOCK_WAIT_MS,
        message,
        updatedAt: now.toISOString(),
      },
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
    await releaseUnattendedCaptureTaskResourcesForRecovery(activeLock, {
      reason: 'unattended_recovery_launch',
      request,
    });
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
    const executionCopy = getUnattendedExecutionCopy(current);
    const nextRequest = {
      ...current,
      status: 'pending',
      recoveryPendingLaunch: false,
      recoveryWaitUntil: '',
      runnerTabId: null,
      heartbeatAt: now,
      businessProgressAt: now,
      updatedAt: now,
      message: `正在启动第 ${current.attemptNumber} 次${executionCopy.runLabel}`,
      progress: {
        ...(current.progress && typeof current.progress === 'object'
          ? current.progress
          : {}),
        phase: 'launching_recovery',
        waitUntil: '',
        remainingMs: null,
        attemptCurrent: Math.max(1, Number(current.recoveryCount) || 1),
        attemptTotal: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
        message: `正在启动第 ${current.attemptNumber} 次${executionCopy.runLabel}`,
        updatedAt: now,
      },
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
      attemptId: pendingRequest.attemptId,
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
      const returnToCloud = exhausted && current.cloudAssigned === true;
      const exhaustedMessage = returnToCloud
        ? `${message}；运行页经过 ${launchFailures} 次分散启动仍失败，当前关键词已交回云端等待其它 Agent 接力`
        : `${message}；运行页连续启动失败 ${launchFailures} 次，请人工检查`;
      const waitUntil = exhausted
        ? ''
        : new Date(
            now.getTime() + UNATTENDED_SUPERVISOR_WAKE_GRACE_MS,
          ).toISOString();
      const nextMessage = exhausted
        ? exhaustedMessage
        : `${message}；下一次运行页启动将在倒计时结束后开始（${launchFailures + 1}/${UNATTENDED_MAX_RECOVERY_ATTEMPTS}）`;
      const nextRequest = {
        ...current,
        status: exhausted
          ? returnToCloud
            ? 'failed'
            : 'needs_action'
          : 'recovering',
        recoveryPendingLaunch: !exhausted,
        recoveryWaitUntil: waitUntil,
        recoveryLaunchFailures: launchFailures,
        finishedAt: exhausted ? now.toISOString() : '',
        updatedAt: now.toISOString(),
        message: nextMessage,
        progress: {
          ...(current.progress && typeof current.progress === 'object'
            ? current.progress
            : {}),
          phase: exhausted
            ? returnToCloud
              ? 'returned_to_cloud_queue'
              : 'recovery_launch_exhausted'
            : 'waiting_recovery_launch',
          waitUntil,
          remainingMs: exhausted
            ? null
            : UNATTENDED_SUPERVISOR_WAKE_GRACE_MS,
          attemptCurrent: Math.min(
            UNATTENDED_MAX_RECOVERY_ATTEMPTS,
            launchFailures + 1,
          ),
          attemptTotal: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
          message: nextMessage,
          updatedAt: now.toISOString(),
        },
        error: {
          code: exhausted
            ? 'UNATTENDED_RECOVERY_LAUNCH_EXHAUSTED'
            : 'RECOVERY_LAUNCH_FAILED',
          message: nextMessage,
          retryable: returnToCloud || !exhausted,
          requiresManualAction: exhausted && !returnToCloud,
          category: 'temporary_runtime_recovery',
          ...(exhausted
            ? {
                fastRetryExhausted: true,
                failureOrigin: 'extension_runtime',
              }
            : {}),
        },
      };
      await persistUnattendedRunMutation(nextRequest, {
        previousRequest: current,
        event: {
          type: exhausted ? 'needs_action' : 'recovery_launch_failed',
          ...(returnToCloud ? {type: 'failed'} : {}),
          message: nextRequest.message,
          at: now.toISOString(),
        },
      });
      return nextRequest;
    });
    return {
      recovered: false,
      deferred: !['needs_action', 'failed'].includes(deferredRequest?.status),
      terminal: ['needs_action', 'failed'].includes(deferredRequest?.status),
      request: deferredRequest,
      reason:
        ['needs_action', 'failed'].includes(deferredRequest?.status)
          ? 'recovery_launch_exhausted'
          : 'recovery_launch_failed',
    };
  }
}

async function recoverUnattendedKeywordRunRequest(request, health) {
  const recoveryBlock = getUnattendedRecoveryBlockReason(request);
  const blockReason = String(recoveryBlock?.message || '').trim();
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
          code: String(
            recoveryBlock?.code || 'UNATTENDED_RECOVERY_BLOCKED',
          ),
          message: blockReason,
          ...(recoveryBlock?.category
            ? {category: String(recoveryBlock.category)}
            : {}),
          ...(recoveryBlock?.securityBlocked === true
            ? {securityBlocked: true}
            : {}),
          requiresManualAction: true,
          retryable: false,
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
      const reasonText = formatUnattendedRecoveryReason(
        health.reason,
        current,
      );
      const cloudAssigned = current.cloudAssigned === true;
      const message = cloudAssigned
        ? `${reasonText}，已完成 ${UNATTENDED_MAX_RECOVERY_ATTEMPTS} 次分散恢复，当前关键词已交回云端等待其它 Agent 接力`
        : `${reasonText}，自动恢复已达到 ${UNATTENDED_MAX_RECOVERY_ATTEMPTS} 次，请人工检查后继续`;
      const nextRequest = {
        ...current,
        status: cloudAssigned ? 'failed' : 'needs_action',
        finishedAt: now,
        updatedAt: now,
        message,
        progress: {
          ...(current.progress && typeof current.progress === 'object'
            ? current.progress
            : {}),
          phase: cloudAssigned
            ? 'returned_to_cloud_queue'
            : 'automatic_recovery_exhausted',
          waitUntil: '',
          remainingMs: null,
          attemptCurrent: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
          attemptTotal: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
          message,
          updatedAt: now,
        },
        error: {
          code: 'UNATTENDED_RECOVERY_EXHAUSTED',
          message,
          retryable: cloudAssigned,
          requiresManualAction: !cloudAssigned,
          category: 'temporary_runtime_recovery',
          fastRetryExhausted: true,
          failureOrigin: 'extension_runtime',
        },
      };
      await persistUnattendedRunMutation(nextRequest, {
        previousRequest: current,
        event: {
          type: cloudAssigned ? 'failed' : 'needs_action',
          message,
          at: now,
        },
      });
      return {action: 'terminal', request: nextRequest};
    }

    const nextRecoveryCount = recoveryCount + 1;
    const reasonText = formatUnattendedRecoveryReason(health.reason, current);
    const recoveryDelayMs = Math.max(
      0,
      Number(
        UNATTENDED_RECOVERY_RETRY_DELAYS_MS[nextRecoveryCount - 1] ??
          UNATTENDED_RECOVERY_RETRY_DELAYS_MS.at(-1),
      ) || 0,
    );
    const recoveryWaitUntil = new Date(
      Date.now() + recoveryDelayMs,
    ).toISOString();
    const message = `${reasonText}，第 ${nextRecoveryCount}/${UNATTENDED_MAX_RECOVERY_ATTEMPTS} 次自动恢复将在倒计时结束后开始`;
    const nextRequest = {
      ...current,
      previousAttemptId: current.attemptId,
      attemptId: createUuid(),
      attemptNumber: Math.max(1, Number(current.attemptNumber) || 1) + 1,
      progressSeq: Math.max(0, Number(current.progressSeq) || 0) + 1,
      recoveryCount: nextRecoveryCount,
      recoveryReason: String(health.reason || ''),
      recoveryPendingLaunch: true,
      recoveryLaunchFailures: 0,
      recoveryWaitUntil,
      status: 'recovering',
      runnerTabId: null,
      heartbeatAt: now,
      businessProgressAt: now,
      updatedAt: now,
      message,
      progress: {
        ...(current.progress && typeof current.progress === 'object'
          ? current.progress
          : {}),
        phase: 'waiting_automatic_recovery',
        waitUntil: recoveryWaitUntil,
        remainingMs: recoveryDelayMs,
        attemptCurrent: nextRecoveryCount,
        attemptTotal: UNATTENDED_MAX_RECOVERY_ATTEMPTS,
        message,
        updatedAt: now,
      },
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
  if (oldUnattendedLock) {
    await releaseUnattendedCaptureTaskResourcesForRecovery(
      oldUnattendedLock,
      {
        reason: `unattended_${String(health?.reason || 'runtime_recovery')}`,
        request: transition.request,
      },
    );
  }
  if (oldUnattendedLock?.id) {
    await releaseCaptureExecutionLock(oldUnattendedLock.id);
  }
  if (transition.action === 'terminal') {
    return {recovered: false, terminal: true, request: transition.request};
  }
  const recoveryWaitUntil = parseTimestampMs(
    transition.request?.recoveryWaitUntil,
  );
  if (Number.isFinite(recoveryWaitUntil) && recoveryWaitUntil > Date.now()) {
    return {
      recovered: false,
      deferred: true,
      reason: 'recovery_wait',
      request: transition.request,
    };
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
  if (mode === 'remaining') {
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
    const currentEntry =
      resultIndex >= 0 ? checkpoint.keywordResults[resultIndex] : null;
    const currentCode = String(
      currentEntry?.errorCode ||
        currentEntry?.error_code ||
        currentEntry?.error?.code ||
        '',
    )
      .trim()
      .toUpperCase();
    const manuallyResolved = Boolean(
      currentEntry &&
        (currentEntry.securityBlocked === true ||
          currentEntry.security_blocked === true ||
          currentEntry.requiresManualAction === true ||
          currentEntry.requires_manual_action === true ||
          [
            'DOUYIN_SEARCH_SECURITY_CHALLENGE',
            'PLATFORM_SAFETY_BLOCK',
            'SECURITY_VERIFICATION_REQUIRED',
            'LOGIN_REQUIRED',
          ].includes(currentCode)),
    );
    if (manuallyResolved) {
      const reopenedEntry = {
        ...currentEntry,
        status: 'retrying',
        attemptCount: 0,
        error: '',
        finishedAt: '',
      };
      for (const field of [
        'securityBlocked',
        'security_blocked',
        'requiresManualAction',
        'requires_manual_action',
        'errorCode',
        'error_code',
        'errorCategory',
        'error_category',
      ]) {
        delete reopenedEntry[field];
      }
      checkpoint.keywordResults[resultIndex] = reopenedEntry;
      checkpoint.failedKeywords = checkpoint.failedKeywords.filter(
        (keyword) => keyword !== currentKeyword,
      );
      if (
        checkpoint.attempts &&
        Object.prototype.hasOwnProperty.call(
          checkpoint.attempts,
          currentKeyword,
        )
      ) {
        delete checkpoint.attempts[currentKeyword];
      }
      checkpoint.activePhase = 'pending';
      checkpoint.phase = '';
      checkpoint.updatedAt = new Date().toISOString();
    }
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

async function manuallyRecoverUnattendedKeywordRun({
  requestId = '',
  mode = 'remaining',
  cloudCommandId = '',
  allowedKeywords = [],
} = {}) {
  const normalizedMode = new Set(['remaining', 'failed', 'skip_current']).has(mode)
    ? mode
    : 'remaining';
  const created = await runUnattendedRunMutation(async () => {
    const currentRequest = await readUnattendedKeywordRunRequest();
    const current =
      currentRequest?.id === requestId
        ? currentRequest
        : await readArchivedUnattendedKeywordRunRequest(requestId);
    if (!current || !requestId) {
      return {accepted: false, reason: 'not_found', request: null};
    }
    if (
      currentRequest &&
      currentRequest.id !== current.id &&
      !isTerminalUnattendedRunStatus(currentRequest.status)
    ) {
      return {
        accepted: false,
        reason: 'unattended_task_busy',
        request: currentRequest,
      };
    }
    if (!isTerminalUnattendedRunStatus(current.status)) {
      return {accepted: false, reason: 'not_recoverable', request: current};
    }
    const credential = await readCloudTaskAgentCredential();
    const currentAgentScopeId = String(credential.id || '').trim();
    const requestAgentScopeId = String(
      current.cloudAgentScopeId || '',
    ).trim();
    if (
      currentAgentScopeId &&
      requestAgentScopeId &&
      currentAgentScopeId !== requestAgentScopeId
    ) {
      return {
        accepted: false,
        reason: 'agent_scope_mismatch',
        request: current,
      };
    }
    if (String(current.recoveryDismissedAt || '').trim()) {
      return {
        accepted: false,
        reason: 'recovery_dismissed',
        request: current,
      };
    }
    if (
      currentRequest &&
      currentRequest.id !== current.id &&
      isRetryableUnattendedRunRequest(currentRequest)
    ) {
      await archiveUnattendedKeywordRunRequest(currentRequest);
    }

    const now = new Date().toISOString();
    let checkpoint = buildManualRecoveryCheckpoint(current, normalizedMode);
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
    const scopedKeywords = Array.from(
      new Set(
        (Array.isArray(allowedKeywords) ? allowedKeywords : [])
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 30);
    if (scopedKeywords.length > 0) {
      const allowedSet = new Set(scopedKeywords);
      const planKeywords = planSnapshot.keywords.filter((keyword) =>
        allowedSet.has(keyword),
      );
      if (planKeywords.length === 0) {
        return {
          accepted: false,
          reason: 'no_allowed_keywords',
          request: current,
        };
      }
      const indexByKeyword = new Map(
        planKeywords.map((keyword, index) => [keyword, index]),
      );
      const activeKeyword = String(
        checkpoint.activeKeyword || checkpoint.currentKeyword || '',
      ).trim();
      const retainedActiveKeyword = allowedSet.has(activeKeyword)
        ? activeKeyword
        : planKeywords[0];
      checkpoint = {
        ...checkpoint,
        round: 1,
        activeKeywordIndex: indexByKeyword.get(retainedActiveKeyword) || 0,
        keywordIndex: indexByKeyword.get(retainedActiveKeyword) || 0,
        activeKeyword: retainedActiveKeyword,
        currentKeyword: retainedActiveKeyword,
        keywordResults: checkpoint.keywordResults
          .filter((entry) => allowedSet.has(String(entry?.keyword || '').trim()))
          .map((entry) => ({
            ...entry,
            round: 1,
            index:
              indexByKeyword.get(String(entry?.keyword || '').trim()) || 0,
          })),
        completedKeywords: checkpoint.completedKeywords.filter((keyword) =>
          allowedSet.has(keyword),
        ),
        failedKeywords: checkpoint.failedKeywords.filter((keyword) =>
          allowedSet.has(keyword),
        ),
        skippedKeywords: checkpoint.skippedKeywords.filter((keyword) =>
          allowedSet.has(keyword),
        ),
        attempts: Object.fromEntries(
          Object.entries(checkpoint.attempts).filter(([keyword]) =>
            allowedSet.has(keyword),
          ),
        ),
        updatedAt: new Date().toISOString(),
      };
      planSnapshot = normalizeUnattendedKeywordPlan({
        ...planSnapshot,
        keywords: planKeywords,
        autoLoop: false,
        maxRounds: 1,
        roundGapMin: 0,
      });
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
      cloudCommandId: String(cloudCommandId || ''),
      attemptId: createUuid(),
      attemptNumber: Math.max(1, Number(current.attemptNumber) || 1) + 1,
      progressSeq: Math.max(0, Number(current.progressSeq) || 0) + 1,
      // 人工继续是用户确认后创建的新根请求，不能继承上一根请求已经耗尽的
      // 自动恢复预算；否则新任务第一次再遇到运行页暂停就会立即 needs_action。
      recoveryCount: 0,
      manualRecoveryCount:
        Math.max(0, Number(current.manualRecoveryCount) || 0) + 1,
      recoveryMode: normalizedMode,
      recoveryReason: 'manual_recovery',
      ...(scopedKeywords.length > 0
        ? {recoveryAllowedKeywords: scopedKeywords}
        : {}),
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
    await removeArchivedUnattendedKeywordRunRequest(current.id);
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
    const message = '检测到浏览器或电脑恢复，等待运行页重新连接';
    const nextRequest = {
      ...current,
      wakeGraceUntil,
      recoveryWaitUntil: wakeGraceUntil,
      updatedAt: now.toISOString(),
      wakeReason: reason,
      message,
      progress: {
        ...(current.progress && typeof current.progress === 'object'
          ? current.progress
          : {}),
        phase: 'waiting_runner_reconnect',
        waitUntil: wakeGraceUntil,
        remainingMs: UNATTENDED_SUPERVISOR_WAKE_GRACE_MS,
        message,
        updatedAt: now.toISOString(),
      },
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: current,
      event: {
        type: 'wake_grace',
        message,
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
    if (health.reason === 'runner_tab_frozen') {
      const wakeResult = await wakeFrozenUnattendedRunnerTab(
        request,
        health.runnerTab,
      );
      if (wakeResult.woken) {
        return {
          healthy: true,
          reason: wakeResult.reason,
          request: wakeResult.request,
        };
      }
      health.reason = wakeResult.reason || health.reason;
      health.error = wakeResult.error || null;
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
      if (existingRequest.cloudAssigned === true) {
        const retryAt = new Date(
          Date.now() + UNATTENDED_LOCK_RETRY_DELAY_MS,
        ).toISOString();
        await saveUnattendedKeywordPlan(
          {
            ...plan,
            nextRunAt: retryAt,
          },
          {recomputeNext: false},
        );
      }
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
  if (
    activeRequest?.cloudAssigned === true &&
    !isTerminalUnattendedRunStatus(activeRequest.status)
  ) {
    const nextRunAt = new Date(plan.nextRunAt).getTime();
    if (!plan.nextRunAt || !Number.isFinite(nextRunAt) || nextRunAt <= Date.now()) {
      return await saveUnattendedKeywordPlan(
        {
          ...plan,
          nextRunAt: new Date(
            Date.now() + UNATTENDED_LOCK_RETRY_DELAY_MS,
          ).toISOString(),
        },
        {recomputeNext: false},
      );
    }
    await syncUnattendedKeywordAlarm(plan);
    return plan;
  }
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

async function cleanupStaleCaptureRuntimeSession(session) {
  if (!session || typeof session !== 'object') return;
  const sourceTabId = resolveCaptureTaskTabId(
    session.sourceTabId,
    session.tabId,
  );
  const workerTabIds = Array.isArray(session.workerTabIds)
    ? [
        ...new Set(
          session.workerTabIds
            .map((tabId) => resolveCaptureTaskTabId(tabId))
            .filter(Boolean),
        ),
      ]
    : [];
  const taskGroupId =
    session.groupId === null ||
    session.groupId === undefined ||
    session.groupId === ''
      ? -1
      : Number(session.groupId);
  const originalGroupId =
    session.originalGroupId === null ||
    session.originalGroupId === undefined ||
    session.originalGroupId === ''
      ? -1
      : Number(session.originalGroupId);
  let verifiedTaskGroup = false;
  if (Number.isSafeInteger(taskGroupId) && taskGroupId >= 0) {
    try {
      const taskGroup = await chrome.tabGroups.get(taskGroupId);
      verifiedTaskGroup =
        String(taskGroup?.title || '').trim() === CAPTURE_TASK_GROUP_TITLE;
    } catch (error) {
      const message = String(error?.message || error || '');
      if (
        /no (?:tab )?group with id|not found|does not exist|invalid group id/iu.test(
          message,
        )
      ) {
        verifiedTaskGroup = false;
      } else {
        throw error;
      }
    }
  }

  let sourceTab = null;
  if (verifiedTaskGroup && sourceTabId) {
    try {
      const candidate = await chrome.tabs.get(sourceTabId);
      if (candidate?.groupId === taskGroupId) sourceTab = candidate;
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/no tab with id|not found|does not exist|invalid tab id/iu.test(message)) {
        sourceTab = null;
      } else {
        throw error;
      }
    }
  }

  const verifiedWorkerTabIds = [];
  if (verifiedTaskGroup) {
    for (const workerTabId of workerTabIds) {
      try {
        const workerTab = await chrome.tabs.get(workerTabId);
        if (workerTab?.groupId === taskGroupId) {
          verifiedWorkerTabIds.push(workerTabId);
        }
      } catch (error) {
        const message = String(error?.message || error || '');
        if (
          !/no tab with id|not found|does not exist|invalid tab id/iu.test(
            message,
          )
        ) {
          throw error;
        }
      }
    }
  }

  await Promise.allSettled(
    [...new Set([sourceTabId, ...workerTabIds].filter(Boolean))].map((tabId) =>
      clearCaptureTaskTraceOverlayFailSoft({
        taskId: session.taskId,
        tabId,
      }),
    ),
  );

  if (chrome.action?.setBadgeText) {
    await chrome.action.setBadgeText({text: ''}).catch(() => null);
  }
  if (sourceTab) {
    await chrome.debugger.detach({tabId: sourceTab.id}).catch((error) => {
      const message = String(error?.message || error || '');
      if (/not attached|no tab with given id|target closed/iu.test(message)) {
        return;
      }
      throw error;
    });
  }
  if (verifiedWorkerTabIds.length > 0) {
    await closeCaptureTaskWorkerTabs(verifiedWorkerTabIds);
  }
  if (!sourceTab) return;
  if (Number.isSafeInteger(originalGroupId) && originalGroupId >= 0) {
    try {
      await chrome.tabs.group({
        groupId: originalGroupId,
        tabIds: [sourceTab.id],
      });
      return;
    } catch {
      // The user's former group no longer exists; ungroup below.
    }
  }
  try {
    await chrome.tabs.ungroup([sourceTab.id]);
  } catch (error) {
    const message = String(error?.message || error || '');
    if (
      /no tab with id|not found|does not exist|not in a group|invalid tab id/iu.test(
        message,
      )
    ) {
      return;
    }
    throw error;
  }
}

let captureRuntimeRestorePromise = null;

async function restorePersistedCaptureRuntimeSession(runtime) {
  const snapshot = runtime?.captureDebugSession;
  if (
    !snapshot ||
    snapshot.persistent !== true ||
    captureDebugSessionManager?.getActiveSessions().length > 0
  ) {
    return {restored: false, reason: 'not_required'};
  }
  if (captureRuntimeRestorePromise) return await captureRuntimeRestorePromise;

  captureRuntimeRestorePromise = (async () => {
    const taskId = String(snapshot.taskId || '').trim();
    if (!taskId) return {restored: false, reason: 'missing_task_id'};
    let attemptId = String(
      snapshot.attemptId ||
        runtime?.lastCaptureProgress?.unattendedAttemptId ||
        '',
    ).trim();
    const initialFence = await inspectUnattendedCaptureTaskAttempt({
      taskId,
      attemptId,
    });
    if (initialFence.unattended && !attemptId) {
      attemptId = String(initialFence.currentAttemptId || '').trim();
    }
    if (initialFence.unattended) {
      const currentFence = await inspectUnattendedCaptureTaskAttempt({
        taskId,
        attemptId,
      });
      if (!currentFence.active || !currentFence.lockMatchesTaskAttempt) {
        return {restored: false, reason: 'stale_unattended_attempt'};
      }
    }

    const restoreSnapshot = {...snapshot, attemptId};
    let group = null;
    try {
      group = await captureTaskTabGroupManager.restore(restoreSnapshot);
      const session = await captureDebugSessionManager.restore(
        {
          ...restoreSnapshot,
          workerTabIds: group.workerTabIds,
          groupId: group.groupId,
          originalGroupId: group.originalGroupId,
        },
      );
      return {restored: true, session, group};
    } catch (error) {
      if (group) captureTaskTabGroupManager.forget(taskId);
      console.warn(
        '[CaptureTask] persisted runtime restore failed:',
        error?.message || error,
      );
      return {
        restored: false,
        reason: error?.code || 'capture_runtime_restore_failed',
        error,
      };
    }
  })();
  try {
    return await captureRuntimeRestorePromise;
  } finally {
    captureRuntimeRestorePromise = null;
  }
}

async function ensureRuntimeState() {
  const beforeRestore = await readRuntimeState();
  await restorePersistedCaptureRuntimeSession(beforeRestore);
  let unattendedRecoveryTaskId = '';
  const nextRuntime = await runRuntimeMutation(async () => {
    const current = await readRuntimeState();
    const nextPatch = {};

    if (
      current.captureDebugSession &&
      captureDebugSessionManager?.getActiveSessions().length === 0
    ) {
      const staleTaskId = String(
        current.captureDebugSession?.taskId || '',
      ).trim();
      const unattended = staleTaskId
        ? await inspectStableUnattendedCaptureTask(staleTaskId)
        : {unattended: false, active: false};
      if (staleTaskId) {
        nextPatch.captureTaskCancellation = buildCaptureTaskCancellation(
          staleTaskId,
          'extension_runtime_restarted',
        );
      }
      nextPatch.lastCaptureProgress = {
        ...(current.lastCaptureProgress &&
        typeof current.lastCaptureProgress === 'object'
          ? current.lastCaptureProgress
          : {}),
        phase: unattended.active ? 'recovering' : 'canceled',
        message: unattended.active
          ? '浏览器后台已重启，正在自动恢复采集任务'
          : '扩展已重新加载，上一采集任务已安全停止',
        updatedAt: new Date().toISOString(),
      };
      // Fence every downstream write before touching debugger, workers or groups.
      // If cleanup fails, the runtime ownership snapshot remains for the next retry.
      await runAuthoritativeControlStorageMutation(
        () => chrome.storage.local.set({
          [STORAGE_KEYS.runtime]: {
            ...current,
            ...nextPatch,
          },
        }),
        {relieveStoragePressure: true},
      );
      await cleanupStaleCaptureRuntimeSession(current.captureDebugSession);
      if (staleTaskId && !unattended.active) {
        await terminalizeCaptureTaskLedgerRun(staleTaskId, {
          reason: 'extension_runtime_restarted',
          message: '扩展已重新加载，上一采集任务已停止',
        });
      }
      nextPatch.captureDebugSession = null;
      if (staleTaskId) {
        captureTaskOwnerCoordinator?.clearTask(staleTaskId);
      }
      if (unattended.active) unattendedRecoveryTaskId = staleTaskId;
    }

    if (!current.clientUuid) {
      nextPatch.clientUuid = createUuid();
    }

    if (!current.clientLabel) {
      nextPatch.clientLabel = getPlatformLabel();
    }

    const installedAppVersion = getAppVersion();
    if (current.appVersion !== installedAppVersion) {
      nextPatch.appVersion = installedAppVersion;
    }

    if (Object.keys(nextPatch).length === 0) {
      return current;
    }

    const next = {
      ...current,
      ...nextPatch,
    };
    await runAuthoritativeControlStorageMutation(
      () => chrome.storage.local.set({
        [STORAGE_KEYS.runtime]: next,
      }),
      {relieveStoragePressure: true},
    );
    return next;
  });
  if (unattendedRecoveryTaskId) {
    await recoverUnattendedCaptureTaskInterruption({
      taskId: unattendedRecoveryTaskId,
      reason: 'extension_runtime_restore_failed',
    }).catch((error) => {
      console.warn(
        '[CaptureTask] automatic recovery after runtime restore failed:',
        error?.message || error,
      );
    });
  }
  return nextRuntime;
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
  return detectPlatformFromUrl(url) !== 'unknown';
}

function detectPlatformFromUrl(url) {
  let hostname = '';
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'unknown';
    }
    hostname = String(parsed.hostname || '').trim().toLowerCase();
  } catch {
    return 'unknown';
  }
  if (hostname === 'xiaohongshu.com' || hostname === 'www.xiaohongshu.com') {
    return 'xiaohongshu';
  }
  if (
    hostname === 'douyin.com' ||
    hostname === 'www.douyin.com' ||
    hostname === 'v.douyin.com'
  ) {
    return 'douyin';
  }
  if (
    hostname === 'weibo.com' ||
    hostname === 'www.weibo.com' ||
    hostname === 's.weibo.com'
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

function createContentRelayWatchdogError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details =
    details && typeof details === 'object' && !Array.isArray(details)
      ? details
      : {};
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
                `页面超过 ${Math.ceil(inactivityTimeoutMs / 1000)} 秒没有采集进度，正在自动恢复当前步骤（动作 ${String(payload?.action || 'unknown')}，阶段 ${String(latestHeartbeat?.phase || 'unknown')}）`,
                {
                  tabId,
                  captureRequestId: requestId,
                  captureAction: String(payload?.action || ''),
                  lastHeartbeatPhase: String(latestHeartbeat?.phase || ''),
                  heartbeatAgeMs,
                },
              ),
            );
            return;
          }

          if (activeElapsedMs >= timeoutMs) {
            reject(
              createContentRelayWatchdogError(
                'CONTENT_RELAY_TIMEOUT',
                `页面采集脚本超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应，已停止当前步骤（动作 ${String(payload?.action || 'unknown')}，阶段 ${String(latestHeartbeat?.phase || 'unknown')}）`,
                {
                  tabId,
                  captureRequestId: requestId,
                  captureAction: String(payload?.action || ''),
                  lastHeartbeatPhase: String(latestHeartbeat?.phase || ''),
                  activeElapsedMs,
                },
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

captureTaskTabGroupManager =
  captureTaskTabGroupApi.createManager({
    tabsApi: chrome.tabs,
    tabGroupsApi: chrome.tabGroups,
    groupTitle: CAPTURE_TASK_GROUP_TITLE,
  });

captureDebugSessionManager =
  globalThis.OnStarvoiceCaptureDebugSession.createManager({
    debuggerApi: chrome.debugger,
    onStateChange: async (session, metadata = {}) => {
      if (chrome.action?.setBadgeText) {
        await Promise.allSettled([
          chrome.action.setBadgeText({text: session ? '1' : ''}),
          chrome.action.setBadgeBackgroundColor({color: '#6f5cff'}),
          chrome.action.setBadgeTextColor
            ? chrome.action.setBadgeTextColor({color: '#ffffff'})
            : Promise.resolve(),
        ]);
      }
      const previousTaskId = String(metadata?.previous?.taskId || '').trim();
      const preserveCleanupSnapshot = Boolean(
        !session &&
          metadata?.previous?.persistent &&
          previousTaskId &&
          captureTaskCleanupInProgress.has(previousTaskId),
      );
      const runtimeSession = preserveCleanupSnapshot
        ? {
            ...metadata.previous,
            state: 'detaching',
            cleanupPending: true,
          }
        : session;
      const patch = {captureDebugSession: runtimeSession};
      if (session?.persistent && session.progress) {
        patch.lastCaptureProgress = session.progress;
      } else if (session && metadata.reason === 'capture_started') {
        patch.lastCaptureProgress = {
          phase: 'debug_session_attached',
          message: `AI 已接管当前页面 · ${session.label}`,
          ...(session.persistent
            ? {captureTaskId: session.taskId}
            : {listCaptureRunId: session.runId}),
          debugSessionState: session.state,
          debugSessionTabId: session.tabId,
          updatedAt: new Date().toISOString(),
        };
      }
      await writeRuntimeState(patch);
    },
    onUnexpectedDetach: async ({session, reason}) => {
      await handleUnexpectedCaptureDebugDetach({session, reason});
    },
  });

function createCaptureTaskError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    error.details = details;
  }
  return error;
}

function getCaptureTaskRequest(message) {
  const payload =
    message?.payload && typeof message.payload === 'object'
      ? message.payload
      : {};
  return {...message, ...payload};
}

function requireCaptureTaskId(request) {
  const taskId = String(request?.taskId || '').trim();
  if (!taskId) {
    throw createCaptureTaskError(
      'invalid_capture_task',
      '采集任务缺少 taskId',
    );
  }
  return taskId;
}

function resolveCaptureTaskTabId(...values) {
  for (const value of values) {
    const tabId = Number(value);
    if (Number.isSafeInteger(tabId) && tabId > 0) return tabId;
  }
  return null;
}

async function requireConnectedCaptureTaskOwner(
  taskId,
  {attempts = 8, delayMs = 50} = {},
) {
  const normalizedTaskId = String(taskId || '').trim();
  const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const owner = captureTaskOwnerCoordinator?.getOwner(normalizedTaskId);
    if (owner?.connected === true) return owner;
    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw createCaptureTaskError(
    'capture_task_owner_disconnected',
    '控制面板未连接，已取消启动采集任务',
  );
}

function isRecentActiveCaptureTaskLedgerRun(run, now = Date.now()) {
  const status = String(run?.status || '').trim().toLowerCase();
  if (!new Set(['pending', 'running', 'recovering']).has(status)) {
    return false;
  }
  const activityAt = taskRunActivityAt(run);
  return Boolean(
    activityAt && now - activityAt < TASK_LEDGER_STALE_ACTIVE_MS,
  );
}

async function inspectCaptureTaskGroupLiveness(group) {
  const taskId = String(group?.taskId || '').trim();
  if (!taskId) {
    return {active: true, reason: 'invalid_task_group'};
  }
  if (captureTaskCleanupInProgress.has(taskId)) {
    return {active: true, reason: 'cleanup_in_progress'};
  }

  const debugSession = captureDebugSessionManager.getSessionByTaskId(taskId);
  const debugSessionState = String(debugSession?.state || '')
    .trim()
    .toLowerCase();
  // A detached persistent snapshot exists only so ordered cleanup can still
  // find its task/workers. It is not proof that capture is alive. Continue
  // through the ledger/request/owner/lock checks so a terminal task can be
  // reclaimed instead of blocking every later begin forever.
  if (debugSession && debugSessionState !== 'detached') {
    return {active: true, reason: 'debug_session', debugSession};
  }

  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.taskLedger,
    STORAGE_KEYS.unattendedKeywordRunRequest,
  ]);
  const core = getUnattendedTaskCenterCore();
  const now = Date.now();
  const ledger = core?.normalizeTaskLedger
    ? core.normalizeTaskLedger(stored[STORAGE_KEYS.taskLedger], {now})
    : stored[STORAGE_KEYS.taskLedger];
  const ledgerRun = Array.isArray(ledger?.runs)
    ? ledger.runs.find((run) => String(run?.id || '').trim() === taskId)
    : null;
  const ledgerStatus = String(ledgerRun?.status || '').trim().toLowerCase();
  const ledgerTerminal = Boolean(
    ledgerRun &&
      (core?.isTerminalTaskStatus?.(ledgerStatus) ||
        new Set([
          'completed',
          'completed_with_warnings',
          'completed_with_failures',
          'failed',
          'canceled',
          'cancelled',
          'skipped',
          'needs_action',
        ]).has(ledgerStatus)),
  );
  if (isRecentActiveCaptureTaskLedgerRun(ledgerRun, now)) {
    return {active: true, reason: 'task_ledger', ledgerRun};
  }

  const unattendedRequest =
    stored[STORAGE_KEYS.unattendedKeywordRunRequest] &&
    typeof stored[STORAGE_KEYS.unattendedKeywordRunRequest] === 'object'
      ? stored[STORAGE_KEYS.unattendedKeywordRunRequest]
      : null;
  if (
    String(unattendedRequest?.id || '').trim() === taskId &&
    (await isUnattendedRunRequestActive(unattendedRequest))
  ) {
    return {
      active: true,
      reason: 'unattended_run_request',
      unattendedRequest,
    };
  }

  // A connected sidebar can briefly survive after its task has already written
  // a terminal tombstone. In that state the owner is cleanup residue, not proof
  // that capture is still running. Without a terminal record, fail closed and
  // keep the owner-owned group intact.
  const owner = captureTaskOwnerCoordinator?.getOwner(taskId);
  if (
    !ledgerTerminal &&
    (owner?.connected === true || owner?.abandoning === true)
  ) {
    return {active: true, reason: 'task_owner', owner};
  }

  const activeLock = await readActiveCaptureExecutionLock();
  const groupTabIds = new Set(
    [
      group?.sourceTabId,
      ...(Array.isArray(group?.workerTabIds) ? group.workerTabIds : []),
    ]
      .map((tabId) => resolveCaptureTaskTabId(tabId))
      .filter(Boolean),
  );
  if (
    activeLock &&
    (activeLock.captureTaskId === taskId ||
      (!activeLock.captureTaskId &&
        groupTabIds.has(resolveCaptureTaskTabId(activeLock.holderTabId))))
  ) {
    return {active: true, reason: 'execution_lock', activeLock};
  }

  return {
    active: false,
    reason: 'confirmed_stale',
    debugSession,
    ledgerRun,
  };
}

async function releaseConfirmedStaleCaptureTaskGroupsForBegin() {
  const releasedTaskIds = [];
  const protectedTasks = [];
  const candidates = captureTaskTabGroupManager.getActiveTasks();
  for (const group of candidates) {
    const liveness = await inspectCaptureTaskGroupLiveness(group);
    if (liveness.active) {
      protectedTasks.push({
        taskId: group.taskId,
        reason: liveness.reason,
      });
      continue;
    }

    try {
      await releaseCaptureTaskResourcesWithRetry(
        {
          taskId: group.taskId,
          reason: 'stale_capture_task_recovered',
          debugSnapshot: liveness.debugSession,
        },
        {attempts: 3},
      );
      releasedTaskIds.push(group.taskId);
    } catch (error) {
      console.warn(
        '[CaptureTask] confirmed stale group cleanup remains pending:',
        {
          taskId: group.taskId,
          error: String(error?.message || error || ''),
        },
      );
      protectedTasks.push({
        taskId: group.taskId,
        reason: 'cleanup_failed',
      });
    }
  }
  return {releasedTaskIds, protectedTasks};
}

async function beginCaptureTask(message, sender) {
  return await runCaptureTaskBeginOperation(async () => {
    const request = getCaptureTaskRequest(message);
    const marker = {
      taskId: requireCaptureTaskId(request),
      attemptId: String(request.attemptId || '').trim(),
      sourceTabId: resolveCaptureTaskTabId(
        request.sourceTabId,
        request.tabId,
        sender?.tab?.id,
      ),
    };
    captureTaskBeginInFlight = marker;
    try {
      return await beginCaptureTaskNow(message, sender);
    } finally {
      if (captureTaskBeginInFlight === marker) {
        captureTaskBeginInFlight = null;
      }
    }
  });
}

async function beginCaptureTaskNow(message, sender) {
  const request = getCaptureTaskRequest(message);
  const taskId = requireCaptureTaskId(request);
  const ownerRequired = request.ownerRequired === true;
  const attemptId = String(request.attemptId || '').trim();
  let sourceTabId = resolveCaptureTaskTabId(
    captureTaskBeginInFlight?.taskId === taskId &&
        captureTaskBeginInFlight?.attemptId === attemptId
      ? captureTaskBeginInFlight.sourceTabId
      : null,
    request.sourceTabId,
    request.tabId,
    sender?.tab?.id,
  );
  if (!sourceTabId) {
    throw createCaptureTaskError(
      'invalid_capture_task_source_tab',
      '采集任务缺少有效的来源 Tab',
    );
  }
  let sourceTab = null;
  try {
    sourceTab = await chrome.tabs.get(sourceTabId);
  } catch (error) {
    const replacement = resolveCaptureTaskReplacementLease(sourceTabId, {
      taskId,
      attemptId,
    });
    const replacementTabId = resolveCaptureTaskTabId(
      captureTaskBeginInFlight?.taskId === taskId &&
          captureTaskBeginInFlight?.attemptId === attemptId
        ? captureTaskBeginInFlight.sourceTabId
        : null,
      replacement?.tabId,
    );
    if (!replacementTabId || replacementTabId === sourceTabId) {
      throw error;
    }
    sourceTabId = replacementTabId;
    sourceTab = await chrome.tabs.get(sourceTabId);
  }
  let sourcePlatform = detectPlatformFromUrl(sourceTab?.url || '');
  const requestedPlatform = normalizePlatformId(request.platform);
  if (!new Set(['xiaohongshu', 'douyin']).has(sourcePlatform)) {
    throw createCaptureTaskError(
      'capture_task_platform_unsupported',
      '任务级 Debug 当前仅支持小红书和抖音',
    );
  }
  if (
    requestedPlatform !== 'unknown' &&
    requestedPlatform !== sourcePlatform
  ) {
    throw createCaptureTaskError(
      'capture_task_platform_mismatch',
      '任务平台与来源页面不一致，已拒绝启动浏览器接管',
    );
  }

  // Fence before consulting the execution lock. Recovery deliberately has a
  // short window where the old lock is gone and the replacement runner has not
  // acquired its lock yet; a late BEGIN from the old document must not use
  // that window to resurrect the previous attempt as a manual task.
  const beginAttemptFence = await inspectUnattendedCaptureTaskAttempt({
    taskId,
    attemptId: request.attemptId,
  });
  if (beginAttemptFence.unattended && !beginAttemptFence.current) {
    throw createCaptureTaskError(
      'stale_unattended_attempt',
      '旧无人值守运行页已失效，已忽略其浏览器接管请求',
    );
  }
  if (beginAttemptFence.unattended && !beginAttemptFence.active) {
    throw createCaptureTaskError(
      'unattended_request_terminal',
      '无人值守任务已结束，未启动浏览器接管',
    );
  }
  if (
    beginAttemptFence.unattended &&
    !beginAttemptFence.hasUnattendedLock
  ) {
    throw createCaptureTaskError(
      'unattended_capture_lock_missing',
      '无人值守任务执行锁已失效，未启动浏览器接管',
    );
  }

  if (ownerRequired) {
    await requireConnectedCaptureTaskOwner(taskId);
  }

  const unattendedBegin = await reclaimSupersededUnattendedCaptureTaskForBegin({
    taskId,
    sourceTabId,
    attemptId: request.attemptId,
    sender,
  });
  let boundExecutionLock = await bindCaptureExecutionLockToTask(
    taskId,
    sourceTabId,
    {
      allowUnattendedRebind: unattendedBegin?.unattended === true,
      attemptId: request.attemptId,
      expectedLockId: beginAttemptFence.lock?.id,
      expectedHolderId: beginAttemptFence.lock?.holderId,
      expectedHolderDocumentId:
        beginAttemptFence.lock?.holderDocumentId,
    },
  );
  if (
    beginAttemptFence.unattended &&
    (!boundExecutionLock ||
      String(boundExecutionLock.owner || '') !== 'unattended_keyword_plan' ||
      String(boundExecutionLock.captureTaskId || '').trim() !== taskId ||
      String(boundExecutionLock.captureTaskAttemptId || '').trim() !==
        String(request.attemptId || '').trim())
  ) {
    throw createCaptureTaskError(
      'unattended_capture_lock_bind_failed',
      '无人值守任务执行锁未能绑定，未启动浏览器接管',
    );
  }

  const reconcileUnattendedBeginFence = async ({rollback = false} = {}) => {
    const fence = await inspectUnattendedCaptureTaskAttempt({
      taskId,
      attemptId,
    });
    const leaseMatches = !fence.unattended || matchesUnattendedBeginLease(
      fence.lock,
      boundExecutionLock,
      {taskId, attemptId},
    );
    if (
      fence.unattended &&
      (!fence.current ||
        !fence.active ||
        !fence.lockMatchesTaskAttempt ||
        !leaseMatches)
    ) {
      const details = describeUnattendedBeginFenceMismatch(
        fence,
        boundExecutionLock,
      );
      console.warn('[CaptureTask] unattended BEGIN fence changed:', details);
      throw createCaptureTaskError(
        'unattended_begin_fence_changed',
        rollback
          ? '无人值守任务状态已经变化，已撤销浏览器接管'
          : '无人值守任务状态已经变化，未启动浏览器接管',
        details,
      );
    }
    const inFlightReplacementTabId = resolveCaptureTaskTabId(
      captureTaskBeginInFlight?.taskId === taskId &&
          captureTaskBeginInFlight?.attemptId === attemptId
        ? captureTaskBeginInFlight.sourceTabId
        : null,
    );
    const replacementTabId = resolveCaptureTaskTabId(
      inFlightReplacementTabId !== sourceTabId
        ? inFlightReplacementTabId
        : fence.unattended
          ? fence.lock?.holderTabId
          : null,
    );
    if (replacementTabId && replacementTabId !== sourceTabId) {
      const replacement = resolveCaptureTaskReplacementLease(sourceTabId, {
        taskId,
        attemptId,
      });
      if (!replacement || replacement.tabId !== replacementTabId) {
        const details = describeUnattendedBeginFenceMismatch(
          fence,
          boundExecutionLock,
        );
        throw createCaptureTaskError(
          'unattended_begin_fence_changed',
          '无人值守任务页面发生了未经确认的切换，未启动浏览器接管',
          details,
        );
      }
      const replacementTab = await chrome.tabs.get(replacementTabId);
      const replacementPlatform = detectPlatformFromUrl(
        replacementTab?.url || '',
      );
      if (
        replacementPlatform !== sourcePlatform ||
        (requestedPlatform !== 'unknown' &&
          replacementPlatform !== requestedPlatform)
      ) {
        throw createCaptureTaskError(
          'capture_task_platform_mismatch',
          '浏览器替换后的任务页面与原任务平台不一致，已拒绝接管',
        );
      }
      sourceTabId = replacementTabId;
      sourceTab = replacementTab;
      sourcePlatform = replacementPlatform;
      if (
        captureTaskBeginInFlight?.taskId === taskId &&
        captureTaskBeginInFlight?.attemptId === attemptId
      ) {
        captureTaskBeginInFlight.sourceTabId = replacementTabId;
      }
    }
    if (fence.unattended) {
      boundExecutionLock = fence.lock;
    }
    return fence;
  };

  await releaseConfirmedStaleCaptureTaskGroupsForBegin();
  await reconcileUnattendedBeginFence();

  const existingSession =
    captureDebugSessionManager.getSessionByTaskId(taskId);
  const existingGroup = captureTaskTabGroupManager.getTask(taskId);
  const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
  if (
    (!existingSession && existingGroup) ||
    pendingWorkerTabIds.length > 0
  ) {
    throw createCaptureTaskError(
      'capture_task_cleanup_pending',
      '上一采集任务仍在安全清理工作页，请稍后重试',
    );
  }
  const conflictingGroup = captureTaskTabGroupManager
    .getActiveTasks()
    .find((candidate) => candidate?.taskId !== taskId);
  if (conflictingGroup) {
    throw createCaptureTaskError(
      'capture_task_group_busy',
      '已有采集标签组正在运行，请先结束当前任务',
    );
  }
  if (existingSession && existingSession.tabId !== sourceTabId) {
    throw createCaptureTaskError(
      'capture_task_source_mismatch',
      '该采集任务已经绑定到另一个来源 Tab',
    );
  }
  const activeDebugSession = captureDebugSessionManager
    .getActiveSessions()
    .find(Boolean);
  if (
    activeDebugSession &&
    (activeDebugSession.state !== 'attached' ||
      !activeDebugSession.persistent ||
      activeDebugSession.taskId !== taskId ||
      activeDebugSession.tabId !== sourceTabId)
  ) {
    throw createCaptureTaskError(
      'capture_task_debug_busy',
      '已有页面处于 AI Debug 采集任务，请先结束当前任务',
    );
  }
  if (!existingSession) {
    if (typeof chrome.debugger?.getTargets !== 'function') {
      throw createCaptureTaskError(
        'capture_task_debug_preflight_unavailable',
        '当前浏览器无法确认页面调试占用状态，未启动采集任务',
      );
    }
    let targets = [];
    try {
      targets = await chrome.debugger.getTargets();
    } catch (error) {
      throw createCaptureTaskError(
        'capture_task_debug_preflight_failed',
        `无法确认页面调试占用状态：${String(error?.message || error || '未知错误')}`,
      );
    }
    const occupied = (Array.isArray(targets) ? targets : []).some(
      (target) =>
        target?.attached === true &&
        Number(target?.tabId) === sourceTabId,
    );
    if (occupied) {
      throw createCaptureTaskError(
        'capture_task_debug_busy',
        '当前页面已被 DevTools 或其他调试任务占用，请关闭后重试',
      );
    }
  }
  await reconcileUnattendedBeginFence();
  let group = null;
  let session = null;

  try {
    group = await captureTaskTabGroupManager.begin({
      taskId,
      sourceTabId,
      title: CAPTURE_TASK_GROUP_TITLE,
    });
    await reconcileUnattendedBeginFence();
    const activeGroupAfterFence =
      captureTaskTabGroupManager.getTask(taskId) || group;
    if (activeGroupAfterFence.sourceTabId !== sourceTabId) {
      const groupReplacement = resolveCaptureTaskReplacementLease(
        activeGroupAfterFence.sourceTabId,
        {taskId, attemptId},
      );
      if (!groupReplacement || groupReplacement.tabId !== sourceTabId) {
        throw createCaptureTaskError(
          'capture_task_replacement_not_rebound',
          '浏览器替换了采集页面，但任务标签组未能重新绑定',
        );
      }
      const groupResult = await captureTaskTabGroupManager.replaceTab({
        removedTabId: activeGroupAfterFence.sourceTabId,
        addedTabId: sourceTabId,
      });
      if (groupResult?.replaced !== true) {
        throw createCaptureTaskError(
          'capture_task_replacement_not_rebound',
          '浏览器替换了采集页面，但任务标签组未能重新绑定',
        );
      }
      group = groupResult.group;
    } else {
      group = activeGroupAfterFence;
    }
    session = await captureDebugSessionManager.start({
      tabId: sourceTabId,
      runId:
        String(request.runId || '').trim() ||
        existingSession?.runId ||
        `capture-task:${taskId}`,
      label: String(request.label || '').trim() || '采集任务',
      pageTitle: sourceTab?.title || '',
      pageUrl: sourceTab?.url || '',
      platform: sourcePlatform,
      persistent: true,
      taskId,
      attemptId: request.attemptId,
      progress: request.progress ?? null,
      workerTabIds: existingSession?.workerTabIds || [],
      groupId: group.groupId,
      originalGroupId: group.originalGroupId,
      minimized: Boolean(request.minimized),
    });

    const update = {taskId, groupId: group.groupId};
    if (Object.prototype.hasOwnProperty.call(request, 'progress')) {
      update.progress = request.progress;
    }
    if (Object.prototype.hasOwnProperty.call(request, 'minimized')) {
      update.minimized = Boolean(request.minimized);
    }
    if (Object.prototype.hasOwnProperty.call(request, 'label')) {
      update.label = request.label;
    }
    session = await captureDebugSessionManager.updateTask(update);
    if (ownerRequired) {
      await requireConnectedCaptureTaskOwner(taskId);
    }
    await writeRuntimeState({captureTaskCancellation: null});
    await reconcileUnattendedBeginFence({rollback: true});
    return {taskId, session, group};
  } catch (error) {
    if (session || group || existingSession || existingGroup) {
      try {
        await releaseCaptureTaskResourcesWithRetry(
          {
            taskId,
            reason: 'capture_task_begin_rollback',
            debugSnapshot: session || existingSession,
          },
          {attempts: 3},
        );
      } catch (cleanupError) {
        console.warn(
          '[CaptureTask] begin rollback remains pending:',
          cleanupError,
        );
      }
    }
    throw error;
  }
}

async function updateCaptureTask(message) {
  const request = getCaptureTaskRequest(message);
  const taskId = requireCaptureTaskId(request);
  const attemptFence = await inspectUnattendedCaptureTaskAttempt({
    taskId,
    attemptId: request.attemptId,
  });
  if (attemptFence.unattended && !attemptFence.current) {
    return {
      taskId,
      ignored: true,
      reason: 'stale_unattended_attempt',
    };
  }
  const update = {taskId};
  for (const field of ['progress', 'label', 'minimized']) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      update[field] = request[field];
    }
  }
  const session = await captureDebugSessionManager.updateTask(update);
  const sourceTabId = resolveCaptureTaskTabId(
    session?.sourceTabId,
    session?.tabId,
  );
  if (sourceTabId && Object.prototype.hasOwnProperty.call(update, 'progress')) {
    chrome.tabs
      .sendMessage(sourceTabId, {
        action: 'setCaptureTaskTakeover',
        taskId,
        active: true,
        label: String(session?.label || 'AI 正在接管'),
        progress: session?.progress || update.progress || {},
      })
      .catch((error) => {
        console.debug(
          '[CaptureTask] page progress overlay unavailable (ignored):',
          error?.message || error,
        );
      });
  }
  return {taskId, session};
}

async function registerCaptureTaskTab(message, sender) {
  const request = getCaptureTaskRequest(message);
  const taskId = requireCaptureTaskId(request);
  const attemptFence = await inspectUnattendedCaptureTaskAttempt({
    taskId,
    attemptId: request.attemptId,
  });
  if (attemptFence.unattended && !attemptFence.current) {
    return {
      taskId,
      ignored: true,
      reason: 'stale_unattended_attempt',
    };
  }
  const role = globalThis.OnStarvoiceCaptureTaskTabGroup.normalizeTaskTabRole(
    request.role,
  );
  if (!role) {
    throw createCaptureTaskError(
      'invalid_capture_task_tab_role',
      '采集工作页角色仅支持 worker 或 detail_worker',
    );
  }
  const workerTabId = resolveCaptureTaskTabId(
    request.workerTabId,
    request.tabId,
    sender?.tab?.id,
  );
  if (!workerTabId) {
    throw createCaptureTaskError(
      'invalid_capture_worker_tab',
      '采集任务缺少有效的工作 Tab',
    );
  }
  if (!captureDebugSessionManager.getSessionByTaskId(taskId)) {
    throw createCaptureTaskError(
      'capture_task_not_found',
      '没有找到正在运行的持久采集任务',
    );
  }

  const group = await captureTaskTabGroupManager.register({
    taskId,
    tabId: workerTabId,
    role,
  });
  let session;
  try {
    session = await captureDebugSessionManager.registerWorkerTab({
      taskId,
      tabId: workerTabId,
      groupId: group.groupId,
    });
  } catch (error) {
    await captureTaskTabGroupManager.unregister({
      taskId,
      tabId: workerTabId,
    }).catch(() => null);
    throw error;
  }
  return {taskId, role, session, group};
}

async function closeCaptureTaskWorkerTabs(workerTabIds = []) {
  return await globalThis.OnStarvoiceCaptureTaskRuntime.closeWorkerTabsIndividually(
    workerTabIds,
    {
      removeTab: (tabId) => chrome.tabs.remove(tabId),
    },
  );
}

async function closeTrackedCaptureTaskWorkerTabs(taskId, workerTabIds = []) {
  try {
    const result = await closeCaptureTaskWorkerTabs(workerTabIds);
    captureTaskPendingWorkerTabIds.delete(taskId);
    return result;
  } catch (error) {
    const failedTabIds = Array.isArray(error?.failedTabIds)
      ? error.failedTabIds
      : workerTabIds;
    captureTaskPendingWorkerTabIds.set(taskId, failedTabIds);
    throw error;
  }
}

function getTrackedCaptureTaskWorkers(taskId, ...snapshots) {
  return globalThis.OnStarvoiceCaptureTaskRuntime.collectWorkerTabIds(
    ...snapshots,
    {
      workerTabIds: captureTaskPendingWorkerTabIds.get(taskId) || [],
    },
  );
}

function replaceTrackedCaptureTaskWorkerTab(
  taskId,
  removedTabId,
  addedTabId,
) {
  const pending = captureTaskPendingWorkerTabIds.get(taskId);
  if (!pending?.length || !pending.includes(removedTabId)) return false;
  captureTaskPendingWorkerTabIds.set(
    taskId,
    Array.from(
      new Set(
        pending.map((tabId) =>
          Number(tabId) === Number(removedTabId) ? Number(addedTabId) : tabId,
        ),
      ),
    ),
  );
  return true;
}

function buildCaptureTaskWorkerSnapshot(taskId, debugSnapshot, groupSnapshot) {
  return {
    ...(groupSnapshot || {}),
    workerTabIds: getTrackedCaptureTaskWorkers(
      taskId,
      debugSnapshot,
      groupSnapshot,
    ),
  };
}

function reportCaptureTaskCancellationPublishError(error, stage) {
  console.warn(
    `[CaptureTask] cancellation ${stage} failed; cleanup continues:`,
    error,
  );
}

async function writeCaptureTaskCancellationFailSoft(cancellation, patch) {
  return await globalThis.OnStarvoiceCaptureTaskRuntime.publishCancellationFailSoft({
    cancellation,
    notify: (value) => {
      captureTaskOwnerCoordinator?.notifyCanceled(value.taskId, value);
    },
    writeState: writeRuntimeState,
    patch,
    onError: reportCaptureTaskCancellationPublishError,
  });
}

async function clearCaptureTaskTraceOverlayFailSoft({
  taskId = '',
  tabId = null,
} = {}) {
  const normalizedTabId = resolveCaptureTaskTabId(tabId);
  if (!normalizedTabId) return false;
  try {
    const response = await chrome.tabs.sendMessage(normalizedTabId, {
      action: 'setCaptureTaskTakeover',
      taskId: String(taskId || '').trim(),
      active: false,
      clearTrace: true,
      label: 'AI 正在接管',
    });
    return response?.ok !== false;
  } catch (error) {
    console.debug(
      '[CaptureTask] page trace cleanup unavailable (ignored):',
      error?.message || error,
    );
    return false;
  }
}

function buildCaptureTaskCancellation(taskId, reason) {
  return {
    taskId: String(taskId || '').trim(),
    reason: String(reason || 'capture_task_canceled').trim(),
    requestedAt: new Date().toISOString(),
  };
}

async function publishCaptureTaskCancellation(taskId, reason) {
  const cancellation = buildCaptureTaskCancellation(taskId, reason);
  await writeCaptureTaskCancellationFailSoft(cancellation, {
    captureTaskCancellation: cancellation,
    lastCaptureProgress: {
      phase: 'canceled',
      message:
        cancellation.reason === 'sidebar_owner_disconnected'
          ? '控制面板已关闭，采集任务已安全停止'
          : '浏览器 Debug 接管已取消，整项采集正在停止',
      captureTaskId: cancellation.taskId,
      updatedAt: cancellation.requestedAt,
    },
  });
  return cancellation;
}

async function relayCaptureTaskCancellation(session, reason) {
  if (!session) return [];
  const cancelListRunId = session.persistent
    ? session.activeListRunId
    : session.runId;
  const cancelPayload = {
    action: 'cancelCapture',
    debugDetachReason: reason,
    ...(cancelListRunId ? {listCaptureRunId: cancelListRunId} : {}),
  };
  const targetTabIds = [
    session.tabId,
    ...(Array.isArray(session.workerTabIds) ? session.workerTabIds : []),
  ]
    .map((tabId) => resolveCaptureTaskTabId(tabId))
    .filter(Boolean);
  return await Promise.allSettled(
    [...new Set(targetTabIds)].map((tabId) =>
      Promise.race([
        relayToContentWithRetry(tabId, cancelPayload),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('capture task cancel relay timeout')),
            1500,
          ),
        ),
      ]),
    ),
  );
}

async function releaseCaptureTaskResources({
  taskId,
  reason,
  debugSnapshot = null,
} = {}) {
  const activeDebugSnapshot =
    debugSnapshot || captureDebugSessionManager.getSessionByTaskId(taskId);
  const groupSnapshot = captureTaskTabGroupManager.getTask(taskId);
  const workerSnapshot = buildCaptureTaskWorkerSnapshot(
    taskId,
    activeDebugSnapshot,
    groupSnapshot,
  );
  const cleanupSnapshot = {
    ...(groupSnapshot || {}),
    ...(activeDebugSnapshot || {}),
    taskId,
    persistent: true,
    tabId:
      resolveCaptureTaskTabId(
        activeDebugSnapshot?.tabId,
        groupSnapshot?.sourceTabId,
      ) || null,
    sourceTabId:
      resolveCaptureTaskTabId(
        activeDebugSnapshot?.sourceTabId,
        activeDebugSnapshot?.tabId,
        groupSnapshot?.sourceTabId,
      ) || null,
    workerTabIds: workerSnapshot.workerTabIds,
    state: 'detaching',
    cleanupPending: true,
    cleanupReason: String(reason || 'capture_task_finished').trim(),
  };
  captureTaskCleanupInProgress.add(taskId);
  if (activeDebugSnapshot || groupSnapshot || workerSnapshot.workerTabIds.length > 0) {
    await writeRuntimeState({captureDebugSession: cleanupSnapshot}).catch(
      (error) => {
        console.warn(
          '[CaptureTask] failed to persist cleanup ownership snapshot:',
          error,
        );
      },
    );
  }
  await clearCaptureTaskTraceOverlayFailSoft({
    taskId,
    tabId: cleanupSnapshot.sourceTabId,
  });

  try {
    const result = await globalThis.OnStarvoiceCaptureTaskRuntime.endTaskResources({
      taskId,
      reason,
      debugSnapshot: activeDebugSnapshot,
      groupSnapshot: workerSnapshot,
      stopDebug: ({taskId: activeTaskId, reason: stopReason}) =>
        captureDebugSessionManager.stopByTaskId(activeTaskId, stopReason),
      endGroup: ({taskId: activeTaskId, reason: stopReason}) =>
        captureTaskTabGroupManager.end({
          taskId: activeTaskId,
          reason: stopReason,
        }),
      closeWorkerTabs: (workerTabIds) =>
        closeTrackedCaptureTaskWorkerTabs(taskId, workerTabIds),
    });
    captureTaskPendingWorkerTabIds.delete(taskId);
    captureTaskOwnerCoordinator?.clearTask(taskId);
    await writeRuntimeState({captureDebugSession: null}).catch((error) => {
      console.warn('[CaptureTask] failed to clear cleanup snapshot:', error);
    });
    return result;
  } finally {
    captureTaskCleanupInProgress.delete(taskId);
  }
}

async function releaseCaptureTaskResourcesWithRetry(
  options,
  {attempts = 2, retryDelayMs = 250} = {},
) {
  const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await releaseCaptureTaskResources(options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

function buildUnattendedCaptureTaskId(requestId = '') {
  const normalizedRequestId = String(requestId || '').trim();
  return normalizedRequestId ? `unattended-capture:${normalizedRequestId}` : '';
}

function parseStableUnattendedCaptureTaskId(taskId = '') {
  const normalizedTaskId = String(taskId || '').trim();
  const prefix = 'unattended-capture:';
  if (!normalizedTaskId.startsWith(prefix)) {
    return {unattended: false, taskId: normalizedTaskId, requestId: ''};
  }
  const requestId = normalizedTaskId.slice(prefix.length).trim();
  return {
    unattended: Boolean(requestId),
    taskId: normalizedTaskId,
    requestId,
  };
}

async function inspectStableUnattendedCaptureTask(taskId = '') {
  const identity = parseStableUnattendedCaptureTaskId(taskId);
  if (!identity.unattended) {
    return {...identity, current: false, active: false, terminal: false, request: null};
  }
  const request = await readUnattendedKeywordRunRequest();
  const current = Boolean(request && String(request.id || '').trim() === identity.requestId);
  const terminal = Boolean(current && isTerminalUnattendedRunStatus(request.status));
  return {
    ...identity,
    current,
    active: Boolean(current && !terminal),
    terminal,
    request: current ? request : null,
  };
}

async function releaseStableUnattendedCaptureTaskResourcesOnly(
  inspection,
  {reason = 'unattended_wrapper_cleanup', debugSnapshot = null} = {},
) {
  if (!inspection?.unattended || !inspection?.taskId) {
    return {released: false, reason: 'not_unattended_stable_task'};
  }
  const taskId = inspection.taskId;
  const storedLock = await readStoredCaptureExecutionLock();
  const lockOwnsTask = Boolean(
    storedLock &&
      String(storedLock.owner || '') === 'unattended_keyword_plan' &&
      String(storedLock.captureTaskId || '').trim() === taskId,
  );
  if (lockOwnsTask) {
    return await releaseUnattendedCaptureTaskResourcesForRecovery(
      storedLock,
      {
        reason,
        request: inspection.request || {id: inspection.requestId},
      },
    );
  }

  const session =
    debugSnapshot || captureDebugSessionManager.getSessionByTaskId(taskId);
  const group = captureTaskTabGroupManager.getTask(taskId);
  const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
  if (session || group || pendingWorkerTabIds.length > 0) {
    return await releaseCaptureTaskResourcesWithRetry(
      {taskId, reason, debugSnapshot: session},
      {attempts: 3},
    );
  }
  captureTaskOwnerCoordinator?.clearTask(taskId);
  return {released: true, taskId, reason: 'already_absent'};
}

function isExplicitCaptureTaskStopReason(reason = '') {
  return new Set([
    'canceled_by_user',
    'user_cancel_requested',
    'unattended_cancel_requested',
    'manual_cancel_requested',
  ]).has(String(reason || '').trim().toLowerCase());
}

async function readUnattendedParentForCaptureTask(taskId = '') {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return null;
  const [lock, request] = await Promise.all([
    readStoredCaptureExecutionLock(),
    readUnattendedKeywordRunRequest(),
  ]);
  if (
    String(lock?.owner || '') !== 'unattended_keyword_plan' ||
    !request ||
    isTerminalUnattendedRunStatus(request.status)
  ) {
    return null;
  }
  const stableTaskId = buildUnattendedCaptureTaskId(request.id);
  if (
    String(lock.captureTaskId || '').trim() !== normalizedTaskId &&
    stableTaskId !== normalizedTaskId
  ) {
    return null;
  }
  return {lock, request, stableTaskId};
}

async function inspectUnattendedCaptureTaskAttempt({
  taskId = '',
  attemptId = '',
} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const incomingAttemptId = String(attemptId || '').trim();
  const stableIdentity = parseStableUnattendedCaptureTaskId(normalizedTaskId);
  if (!stableIdentity.unattended) {
    return {unattended: false, current: true};
  }
  const [lock, request] = await Promise.all([
    readStoredCaptureExecutionLock(),
    readUnattendedKeywordRunRequest(),
  ]);
  const requestMatches = Boolean(
    request && String(request.id || '').trim() === stableIdentity.requestId,
  );
  const terminal = Boolean(
    requestMatches && isTerminalUnattendedRunStatus(request.status),
  );
  const unattendedLock = Boolean(
    lock && String(lock.owner || '') === 'unattended_keyword_plan',
  );
  const boundAttemptId =
    unattendedLock &&
    String(lock?.captureTaskId || '').trim() === normalizedTaskId
      ? String(lock?.captureTaskAttemptId || '').trim()
      : '';
  const currentAttemptId =
    boundAttemptId ||
    (requestMatches ? String(request.attemptId || '').trim() : '');
  const current = Boolean(
    requestMatches &&
      incomingAttemptId &&
      currentAttemptId &&
      incomingAttemptId === currentAttemptId
  );
  const lockMatchesTaskAttempt = Boolean(
    unattendedLock &&
      String(lock?.captureTaskId || '').trim() === normalizedTaskId &&
      String(lock?.captureTaskAttemptId || '').trim() === incomingAttemptId
  );
  return {
    unattended: true,
    current,
    active: Boolean(current && !terminal),
    terminal,
    hasUnattendedLock: unattendedLock,
    lockMatchesTaskAttempt,
    lock,
    incomingAttemptId,
    currentAttemptId,
    request: requestMatches ? request : null,
    requestId: stableIdentity.requestId,
  };
}

function matchesUnattendedBeginLease(
  actualLock,
  expectedLock,
  {taskId = '', attemptId = ''} = {},
) {
  const stableLeaseMatches = Boolean(
    actualLock &&
      expectedLock &&
      String(actualLock.id || '') === String(expectedLock.id || '') &&
      String(actualLock.owner || '') === String(expectedLock.owner || '') &&
      String(actualLock.holderId || '') ===
        String(expectedLock.holderId || '') &&
      String(actualLock.holderDocumentId || '') ===
        String(expectedLock.holderDocumentId || '') &&
      String(actualLock.captureTaskId || '').trim() ===
        String(expectedLock.captureTaskId || '').trim() &&
      String(actualLock.captureTaskAttemptId || '').trim() ===
        String(expectedLock.captureTaskAttemptId || '').trim()
  );
  if (!stableLeaseMatches) return false;

  const actualTabId = resolveCaptureTaskTabId(actualLock.holderTabId);
  const expectedTabId = resolveCaptureTaskTabId(expectedLock.holderTabId);
  if (actualTabId === expectedTabId) return true;
  const replacement = resolveCaptureTaskReplacementLease(expectedTabId, {
    taskId:
      String(taskId || '').trim() ||
      String(expectedLock.captureTaskId || '').trim(),
    attemptId:
      String(attemptId || '').trim() ||
      String(expectedLock.captureTaskAttemptId || '').trim(),
  });
  return Boolean(replacement && replacement.tabId === actualTabId);
}

function describeUnattendedBeginFenceMismatch(actualFence, expectedLock) {
  const actualLock = actualFence?.lock || null;
  return {
    current: actualFence?.current === true,
    active: actualFence?.active === true,
    lockMatchesTaskAttempt: actualFence?.lockMatchesTaskAttempt === true,
    expected: {
      lockId: String(expectedLock?.id || ''),
      owner: String(expectedLock?.owner || ''),
      holderId: String(expectedLock?.holderId || ''),
      holderDocumentId: String(expectedLock?.holderDocumentId || ''),
      holderTabId: resolveCaptureTaskTabId(expectedLock?.holderTabId),
      captureTaskId: String(expectedLock?.captureTaskId || ''),
      attemptId: String(expectedLock?.captureTaskAttemptId || ''),
    },
    actual: {
      lockId: String(actualLock?.id || ''),
      owner: String(actualLock?.owner || ''),
      holderId: String(actualLock?.holderId || ''),
      holderDocumentId: String(actualLock?.holderDocumentId || ''),
      holderTabId: resolveCaptureTaskTabId(actualLock?.holderTabId),
      captureTaskId: String(actualLock?.captureTaskId || ''),
      attemptId: String(actualLock?.captureTaskAttemptId || ''),
    },
  };
}

async function clearUnattendedCaptureTaskLockBinding(
  lockId,
  taskId,
  {
    expectedHolderId = '',
    expectedHolderDocumentId = '',
    expectedHolderTabId = null,
  } = {},
) {
  const normalizedLockId = String(lockId || '').trim();
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedLockId || !normalizedTaskId) return false;
  const clearBinding = () => runCaptureExecutionLockOperation(async () => {
    const stored = await chrome.storage.local.get(
      STORAGE_KEYS.captureExecutionLock,
    );
    const lock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    if (
      !lock ||
      lock.id !== normalizedLockId ||
      String(lock.owner || '') !== 'unattended_keyword_plan' ||
      String(lock.captureTaskId || '').trim() !== normalizedTaskId ||
      (expectedHolderId &&
        String(lock.holderId || '') !== String(expectedHolderId)) ||
      (expectedHolderDocumentId &&
        String(lock.holderDocumentId || '') !==
          String(expectedHolderDocumentId)) ||
      (resolveCaptureTaskTabId(expectedHolderTabId) &&
        resolveCaptureTaskTabId(lock.holderTabId) !==
          resolveCaptureTaskTabId(expectedHolderTabId))
    ) {
      return false;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: {
        ...lock,
        captureTaskId: '',
        captureTaskAttemptId: '',
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  });
  return await runAuthoritativeControlStorageMutation(clearBinding);
}

async function releaseUnattendedCaptureTaskResourcesForRecovery(
  lock,
  {reason = 'unattended_runtime_recovery', request = null} = {},
) {
  // Recovery can clear the persisted lock binding before every asynchronous
  // Debug/group/worker cleanup callback has finished.  The replacement runner
  // still uses the stable request task id, so an empty captureTaskId must not
  // make those residual resources invisible to the next recovery attempt.
  const stableTaskId = buildUnattendedCaptureTaskId(request?.id);
  const taskId = String(lock?.captureTaskId || stableTaskId || '').trim();
  if (!taskId) return {released: false, reason: 'no_capture_task'};
  const debugSnapshot = captureDebugSessionManager.getSessionByTaskId(taskId);
  const groupSnapshot = captureTaskTabGroupManager.getTask(taskId);
  const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(taskId);
  if (debugSnapshot || groupSnapshot || pendingWorkerTabIds.length > 0) {
    await releaseCaptureTaskResourcesWithRetry(
      {taskId, reason, debugSnapshot},
      {attempts: 3},
    );
  } else {
    captureTaskOwnerCoordinator?.clearTask(taskId);
  }
  await clearUnattendedCaptureTaskLockBinding(lock?.id, taskId, {
    expectedHolderId: lock?.holderId,
    expectedHolderDocumentId: lock?.holderDocumentId,
    expectedHolderTabId: lock?.holderTabId,
  });

  // 0.3.43 及更早版本为每次 runner 生成随机 child task。只收口这类
  // 旧记录；新版使用同一 request 的稳定 taskId，恢复后仍是同一项任务。
  if (!stableTaskId || taskId !== stableTaskId) {
    await terminalizeCaptureTaskLedgerRun(taskId, {
      reason: 'unattended_attempt_replaced',
      status: 'canceled',
      message: '无人值守运行页已迁移，旧浏览器接管会话已释放',
    });
  }
  return {released: true, taskId};
}

async function recoverUnattendedCaptureTaskInterruption({
  taskId = '',
  reason = 'runtime_interrupted',
} = {}) {
  const parent = await readUnattendedParentForCaptureTask(taskId);
  if (!parent) return {handled: false, reason: 'not_unattended'};
  const recovery = await recoverUnattendedKeywordRunRequest(parent.request, {
    healthy: false,
    reason,
  });
  return {handled: true, recovery};
}

function readUnattendedRequestIdFromSender(sender = null) {
  const candidateUrls = [sender?.url, sender?.tab?.url];
  for (const candidate of candidateUrls) {
    try {
      const url = new URL(String(candidate || ''));
      const requestId = String(
        url.searchParams.get(UNATTENDED_RUNNER_QUERY_KEY) || '',
      ).trim();
      if (requestId) return requestId;
    } catch {
      // Ignore non-URL sender metadata.
    }
  }
  return '';
}

async function assertUnattendedBeginCleanupFence({
  expectedLock = null,
  requestId = '',
  attemptId = '',
} = {}) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedAttemptId = String(attemptId || '').trim();
  return await runCaptureExecutionLockOperation(async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.captureExecutionLock,
      STORAGE_KEYS.unattendedKeywordRunRequest,
    ]);
    const lock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    const request = normalizeUnattendedRunRequest(
      stored[STORAGE_KEYS.unattendedKeywordRunRequest],
    );
    const expectedHolderTabId = resolveCaptureTaskTabId(
      expectedLock?.holderTabId,
    );
    const holderSnapshotMatches = Boolean(
      lock &&
        expectedLock &&
        String(lock.owner || '') === 'unattended_keyword_plan' &&
        lock.id === String(expectedLock.id || '') &&
        String(lock.holderId || '') ===
          String(expectedLock.holderId || '') &&
        String(lock.holderDocumentId || '') ===
          String(expectedLock.holderDocumentId || '') &&
        resolveCaptureTaskTabId(lock.holderTabId) === expectedHolderTabId &&
        String(lock.captureTaskId || '').trim() ===
          String(expectedLock.captureTaskId || '').trim() &&
        String(lock.captureTaskAttemptId || '').trim() ===
          String(expectedLock.captureTaskAttemptId || '').trim()
    );
    const requestSnapshotMatches = Boolean(
      request &&
        String(request.id || '').trim() === normalizedRequestId &&
        (!normalizedAttemptId ||
          String(request.attemptId || '').trim() === normalizedAttemptId) &&
        !isTerminalUnattendedRunStatus(request.status)
    );
    if (!holderSnapshotMatches || !requestSnapshotMatches) {
      throw createCaptureTaskError(
        'unattended_runner_mismatch',
        '无人值守运行页凭证已更换，已忽略旧页面的浏览器接管请求',
      );
    }
    return {lock, request};
  });
}

async function reclaimSupersededUnattendedCaptureTaskForBegin({
  taskId,
  sourceTabId,
  attemptId,
  sender,
} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedSourceTabId = resolveCaptureTaskTabId(sourceTabId);
  const [lock, request] = await Promise.all([
    readStoredCaptureExecutionLock(),
    readUnattendedKeywordRunRequest(),
  ]);
  if (
    !normalizedTaskId ||
    !normalizedSourceTabId ||
    String(lock?.owner || '') !== 'unattended_keyword_plan' ||
    !request ||
    isTerminalUnattendedRunStatus(request.status)
  ) {
    return {unattended: false, reclaimed: false};
  }

  const senderRequestId = readUnattendedRequestIdFromSender(sender);
  const senderDocumentId = String(sender?.documentId || '').trim();
  const senderRunnerTabId = resolveCaptureTaskTabId(sender?.tab?.id);
  const authorizedRunner = Boolean(
    (senderRequestId && senderRequestId === String(request.id || '').trim()) &&
      ((!lock.holderDocumentId ||
        senderDocumentId === String(lock.holderDocumentId || '').trim()) ||
        (!senderDocumentId &&
          senderRunnerTabId === resolveCaptureTaskTabId(request.runnerTabId))),
  );
  const stableTaskId = buildUnattendedCaptureTaskId(request.id);
  const attemptFence = await inspectUnattendedCaptureTaskAttempt({
    taskId: normalizedTaskId,
    attemptId,
  });
  if (attemptFence.unattended && !attemptFence.current) {
    throw createCaptureTaskError(
      'stale_unattended_attempt',
      '旧无人值守运行页已失效，已忽略其浏览器接管请求',
    );
  }
  if (!authorizedRunner) {
    if (normalizedTaskId === stableTaskId) {
      throw createCaptureTaskError(
        'unattended_runner_mismatch',
        '无人值守运行页凭证已更换，已忽略旧页面的浏览器接管请求',
      );
    }
    return {unattended: false, reclaimed: false};
  }

  const previousTaskId = String(lock.captureTaskId || '').trim();
  const recoveryTaskId = previousTaskId || stableTaskId;
  const previousSession = recoveryTaskId
    ? captureDebugSessionManager.getSessionByTaskId(recoveryTaskId)
    : null;
  const previousGroup = recoveryTaskId
    ? captureTaskTabGroupManager.getTask(recoveryTaskId)
    : null;
  const previousWorkerTabIds = recoveryTaskId
    ? getTrackedCaptureTaskWorkers(recoveryTaskId)
    : [];
  const sourceChanged = Boolean(
    previousSession &&
      resolveCaptureTaskTabId(previousSession.tabId) !== normalizedSourceTabId,
  );
  const groupSourceChanged = Boolean(
    previousGroup &&
      resolveCaptureTaskTabId(previousGroup.sourceTabId) !==
        normalizedSourceTabId,
  );
  const residualCleanupPending = Boolean(
    recoveryTaskId === normalizedTaskId &&
      // getTrackedCaptureTaskWorkers() without snapshots only exposes worker
      // tabs whose earlier close failed; live session/group workers are not in
      // this set and must not cause a healthy duplicate BEGIN to be released.
      ((!previousSession && previousGroup) ||
        previousWorkerTabIds.length > 0),
  );
  if (
    recoveryTaskId &&
    (recoveryTaskId !== normalizedTaskId ||
      sourceChanged ||
      groupSourceChanged ||
      residualCleanupPending)
  ) {
    const cleanupFence = await assertUnattendedBeginCleanupFence({
      expectedLock: lock,
      requestId: request.id,
      attemptId,
    });
    await releaseUnattendedCaptureTaskResourcesForRecovery(
      {...cleanupFence.lock, captureTaskId: recoveryTaskId},
      {
        reason: 'unattended_runner_rebound',
        request: cleanupFence.request,
      },
    );
  }
  return {
    unattended: true,
    reclaimed: Boolean(previousTaskId),
    request,
  };
}

async function endCaptureTask(message) {
  const request = getCaptureTaskRequest(message);
  const taskId = requireCaptureTaskId(request);
  const attemptFence = await inspectUnattendedCaptureTaskAttempt({
    taskId,
    attemptId: request.attemptId,
  });
  if (attemptFence.unattended && !attemptFence.current) {
    return {
      taskId,
      released: false,
      ignored: true,
      reason: 'stale_unattended_attempt',
    };
  }
  const targetedAttempt = attemptFence.unattended
    ? {targeted: false, current: false}
    : await inspectTargetedPostCaptureTaskAttempt({
        taskId,
        attemptId: request.attemptId,
      });
  if (targetedAttempt.targeted && !targetedAttempt.current) {
    return {
      taskId,
      released: false,
      ignored: true,
      reason: 'stale_targeted_post_attempt',
    };
  }
  const reason =
    String(request.reason || '').trim() || 'capture_task_finished';
  const status = String(request.status || '').trim().toLowerCase();
  const canceled =
    status === 'canceled' ||
    /(?:^|_)(?:cancel|canceled|cancelled)(?:_|$)/u.test(reason) ||
    reason === 'user_cancel_requested';
  if (canceled) {
    const session = captureDebugSessionManager.getSessionByTaskId(taskId);
    await publishCaptureTaskCancellation(taskId, reason);
    await relayCaptureTaskCancellation(session, reason);
  }
  const result = await releaseCaptureTaskResourcesWithRetry({taskId, reason});
  const terminalStatus = status || (canceled ? 'canceled' : 'completed');
  if (terminalStatus === 'recovering') {
    // 无人值守 request root 是唯一公开任务台账；其 Debug wrapper 只管理
    // 浏览器资源。不要再凭 unattended-capture:<id> 创建第二条 recovering
    // 记录，否则作品级进度会和关键词级 counts 混在一起。
    if (!attemptFence.unattended) {
      if (targetedAttempt.current) return result;
      const now = new Date().toISOString();
      await upsertTaskLedgerRun({
        patch: {
          id: taskId,
          status: 'recovering',
          message: '正在重建浏览器采集上下文',
          updatedAt: now,
          businessProgressAt: now,
          finishedAt: '',
          error: null,
          progress: {
            phase: 'recovering',
            message: '正在重建浏览器采集上下文 · 1/1',
            captureTaskId: taskId,
            updatedAt: now,
          },
        },
        event: {
          type: 'task_recovering',
          status: 'recovering',
          message: '旧采集上下文已释放，正在创建新工作页',
        },
      });
    }
    return result;
  }
  // The targeted request root is the sole public task-ledger authority. Its
  // native Debug END only releases tabs/Debug ownership; detail capture can
  // finish before sync, so terminalizing here would absorb a later real sync
  // failure as an update to an already-terminal task-center record.
  if (!attemptFence.unattended && !targetedAttempt.current) {
    await terminalizeCaptureTaskLedgerRun(taskId, {
      reason,
      status: terminalStatus,
      message:
        terminalStatus === 'completed'
          ? '采集任务已完成'
          : terminalStatus === 'skipped'
            ? '采集任务已跳过'
            : terminalStatus === 'completed_with_failures'
              ? '采集任务已完成，部分内容处理失败'
              : terminalStatus === 'failed'
                ? '采集任务执行失败'
                : '采集任务已停止',
    });
  }
  return result;
}

async function handleUnexpectedCaptureDebugDetach({session, reason} = {}) {
  if (!session) return;
  if (!session.persistent || !session.taskId) {
    await relayCaptureTaskCancellation(session, reason);
    return;
  }

  const stableUnattended = await inspectStableUnattendedCaptureTask(
    session.taskId,
  );
  if (stableUnattended.active) {
    const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
      taskId: session.taskId,
      reason:
        String(reason || '').trim() === 'target_closed'
          ? 'debug_target_closed'
          : 'runner_owner_disconnected',
    });
    if (unattendedRecovery.handled) return;
  }
  if (stableUnattended.unattended) {
    // The request root is the only public unattended task. Once that root is
    // terminal (or a later request has replaced it), a delayed Debug detach
    // may only release browser resources; it must never create a second
    // unattended-capture:<id> task-center record.
    await releaseStableUnattendedCaptureTaskResourcesOnly(stableUnattended, {
      reason: 'debugger_detached',
      debugSnapshot: session,
    });
    return;
  }

  if (!isExplicitCaptureTaskStopReason(reason)) {
    const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
      taskId: session.taskId,
      reason:
        String(reason || '').trim() === 'target_closed'
          ? 'debug_target_closed'
          : 'runner_owner_disconnected',
    });
    if (unattendedRecovery.handled) return;
  }

  await publishCaptureTaskCancellation(session.taskId, 'native_debug_canceled');
  await terminalizeCaptureTaskLedgerRun(session.taskId, {
    reason: 'native_debug_canceled',
    message: '浏览器 Debug 接管已取消，采集任务已停止',
  });
  await relayCaptureTaskCancellation(session, reason);
  try {
    await releaseCaptureTaskResourcesWithRetry(
      {
        taskId: session.taskId,
        reason: 'debugger_detached',
        debugSnapshot: session,
      },
      {attempts: 3},
    );
  } catch (error) {
    console.warn(
      '[CaptureDebugSession] failed to finish externally canceled task:',
      error,
    );
  }
}

async function handleAbandonedCaptureTask({taskId} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return;
  const stableUnattended = await inspectStableUnattendedCaptureTask(
    normalizedTaskId,
  );
  if (stableUnattended.active) {
    const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
      taskId: normalizedTaskId,
      reason: 'runner_owner_disconnected',
    });
    if (unattendedRecovery.handled) return;
  }
  if (stableUnattended.unattended) {
    await releaseStableUnattendedCaptureTaskResourcesOnly(stableUnattended, {
      reason: 'sidebar_owner_disconnected',
    });
    return;
  }
  const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
    taskId: normalizedTaskId,
    reason: 'runner_owner_disconnected',
  });
  if (unattendedRecovery.handled) return;
  const session = captureDebugSessionManager.getSessionByTaskId(normalizedTaskId);
  const group = captureTaskTabGroupManager.getTask(normalizedTaskId);
  const pendingWorkerTabIds = getTrackedCaptureTaskWorkers(normalizedTaskId);
  if (!session && !group && pendingWorkerTabIds.length === 0) {
    await terminalizeCaptureTaskLedgerRun(normalizedTaskId, {
      reason: 'sidebar_owner_disconnected',
      message: '控制面板已关闭，采集任务已停止',
    });
    return;
  }

  await publishCaptureTaskCancellation(
    normalizedTaskId,
    'sidebar_owner_disconnected',
  );
  await terminalizeCaptureTaskLedgerRun(normalizedTaskId, {
    reason: 'sidebar_owner_disconnected',
    message: '控制面板已关闭，采集任务已停止',
  });
  await relayCaptureTaskCancellation(session, 'sidebar_owner_disconnected');
  try {
    await releaseCaptureTaskResourcesWithRetry(
      {
        taskId: normalizedTaskId,
        reason: 'sidebar_owner_disconnected',
        debugSnapshot: session,
      },
      {attempts: 3},
    );
  } catch (error) {
    console.warn(
      '[CaptureTaskOwner] failed to finish abandoned capture task:',
      error,
    );
  }
}

async function setCaptureTaskMinimized(message) {
  const request = getCaptureTaskRequest(message);
  const taskId = requireCaptureTaskId(request);
  const session = await captureDebugSessionManager.setMinimized({
    taskId,
    minimized: Boolean(request.minimized),
  });
  return {taskId, session};
}

captureTaskOwnerCoordinator =
  globalThis.OnStarvoiceCaptureTaskOwner.createCoordinator({
    onAbandoned: handleAbandonedCaptureTask,
  });

async function replaceCaptureExecutionLockTabId(removedTabId, addedTabId) {
  return await runCaptureExecutionLockOperation(async () => {
    const stored = await chrome.storage.local.get(
      STORAGE_KEYS.captureExecutionLock,
    );
    const lock = normalizeCaptureExecutionLock(
      stored[STORAGE_KEYS.captureExecutionLock],
      {allowExpired: true},
    );
    if (!lock || Number(lock.holderTabId) !== Number(removedTabId)) {
      return false;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.captureExecutionLock]: {
        ...lock,
        holderTabId: Number(addedTabId),
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  });
}

async function replaceUnattendedRunnerTabId(removedTabId, addedTabId) {
  return await runUnattendedRunMutation(async () => {
    const request = await readUnattendedKeywordRunRequest();
    if (
      !request ||
      isTerminalUnattendedRunStatus(request.status) ||
      Number(request.runnerTabId) !== Number(removedTabId)
    ) {
      return false;
    }
    const now = new Date().toISOString();
    const nextRequest = {
      ...request,
      runnerTabId: Number(addedTabId),
      updatedAt: now,
    };
    await persistUnattendedRunMutation(nextRequest, {
      previousRequest: request,
      event: {
        type: 'runner_replaced',
        message: '浏览器已替换运行页，任务继续执行',
        at: now,
      },
    });
    return true;
  });
}

async function handleCaptureRuntimeTabReplaced(addedTabId, removedTabId) {
  const normalizedAddedTabId = resolveCaptureTaskTabId(addedTabId);
  const normalizedRemovedTabId = resolveCaptureTaskTabId(removedTabId);
  if (!normalizedAddedTabId || !normalizedRemovedTabId) return false;

  const previousDebugSession =
    captureDebugSessionManager.getSession(normalizedRemovedTabId);
  const previousGroup = captureTaskTabGroupManager
    .getActiveTasks()
    .find(
      (group) =>
        Number(group?.sourceTabId) === normalizedRemovedTabId ||
        group?.workerTabIds?.includes(normalizedRemovedTabId),
    );
  const pendingBegin =
    captureTaskBeginInFlight &&
    resolveCaptureTaskTabId(captureTaskBeginInFlight.sourceTabId) ===
      normalizedRemovedTabId
      ? captureTaskBeginInFlight
      : null;
  const taskId = String(
    previousDebugSession?.taskId ||
      previousGroup?.taskId ||
      pendingBegin?.taskId ||
      '',
  ).trim();
  const attemptId = String(
    previousDebugSession?.attemptId || pendingBegin?.attemptId || '',
  ).trim();
  const replacementRole =
    Number(previousGroup?.sourceTabId) === normalizedRemovedTabId
      ? 'source'
      : previousGroup?.workerTabIds?.includes(normalizedRemovedTabId)
        ? 'worker'
        : previousDebugSession?.persistent
          ? 'source'
          : '';

  if (!taskId) {
    await Promise.all([
      replaceCaptureExecutionLockTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
      replaceUnattendedRunnerTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
    ]);
    return false;
  }

  rememberCaptureTaskReplacementTab({
    removedTabId: normalizedRemovedTabId,
    addedTabId: normalizedAddedTabId,
    taskId,
    attemptId,
  });
  if (pendingBegin) {
    pendingBegin.sourceTabId = normalizedAddedTabId;
  }
  if (pendingBegin && !previousDebugSession && !previousGroup) {
    await Promise.all([
      replaceCaptureExecutionLockTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
      replaceUnattendedRunnerTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
    ]);
    return true;
  }

  let replacementTab = null;
  try {
    replacementTab = await chrome.tabs.get(normalizedAddedTabId);
    const groupResult = await captureTaskTabGroupManager.replaceTab({
      removedTabId: normalizedRemovedTabId,
      addedTabId: normalizedAddedTabId,
    });
    const debugResult = await captureDebugSessionManager.replaceTab({
      removedTabId: normalizedRemovedTabId,
      addedTabId: normalizedAddedTabId,
      pageTitle: replacementTab?.title || '',
      pageUrl: replacementTab?.url || '',
    });
    const debugBindingCanFinishInBegin = Boolean(
      pendingBegin &&
        replacementRole === 'source' &&
        !previousDebugSession,
    );
    if (
      groupResult?.replaced !== true ||
      (replacementRole &&
        debugResult?.replaced !== true &&
        !debugBindingCanFinishInBegin)
    ) {
      throw createCaptureTaskError(
        'capture_task_replacement_not_rebound',
        '浏览器替换了采集页面，但任务未能重新绑定',
      );
    }
    if (groupResult?.role === 'worker' || debugResult?.role === 'worker') {
      replaceTrackedCaptureTaskWorkerTab(
        taskId,
        normalizedRemovedTabId,
        normalizedAddedTabId,
      );
    }
    await Promise.all([
      replaceCaptureExecutionLockTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
      replaceUnattendedRunnerTabId(
        normalizedRemovedTabId,
        normalizedAddedTabId,
      ),
    ]);
    rememberCaptureTaskReplacementTab({
      removedTabId: normalizedRemovedTabId,
      addedTabId: normalizedAddedTabId,
      taskId,
      attemptId,
    });
    return true;
  } catch (error) {
    const message = `浏览器替换采集页面后接管迁移失败：${String(
      error?.message || error || '未知错误',
    )}`;
    const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
      taskId,
      reason: 'source_tab_replace_failed',
    });
    if (unattendedRecovery.handled) {
      return Boolean(unattendedRecovery.recovery?.recovered);
    }
    await publishCaptureTaskCancellation(
      taskId,
      'source_tab_replace_failed',
    );
    await terminalizeCaptureTaskLedgerRun(taskId, {
      reason: 'source_tab_replace_failed',
      message,
    });
    const latestSession =
      captureDebugSessionManager.getSessionByTaskId(taskId) ||
      previousDebugSession;
    await relayCaptureTaskCancellation(
      latestSession,
      'source_tab_replace_failed',
    );
    try {
      await releaseCaptureTaskResourcesWithRetry(
        {
          taskId,
          reason: 'source_tab_replace_failed',
          debugSnapshot: latestSession,
        },
        {attempts: 3},
      );
    } catch (cleanupError) {
      console.warn(
        '[CaptureTask] replaced-tab cleanup remains pending:',
        cleanupError,
      );
    }
    return false;
  }
}

async function handleCaptureRuntimeTabRemoved(tabId) {
  const session = captureDebugSessionManager.getSession(tabId);
  if (session?.persistent && session.taskId) {
    const stableUnattended = await inspectStableUnattendedCaptureTask(
      session.taskId,
    );
    if (stableUnattended.active) {
      const unattendedRecovery = await recoverUnattendedCaptureTaskInterruption({
        taskId: session.taskId,
        reason: 'source_tab_removed',
      });
      if (unattendedRecovery.handled) return;
    }
    if (stableUnattended.unattended) {
      await releaseStableUnattendedCaptureTaskResourcesOnly(
        stableUnattended,
        {
          reason: 'source_tab_removed',
          debugSnapshot: session,
        },
      );
      return;
    }
    await publishCaptureTaskCancellation(session.taskId, 'source_tab_removed');
    await terminalizeCaptureTaskLedgerRun(session.taskId, {
      reason: 'source_tab_removed',
      message: '采集来源页面已关闭，任务已停止',
    });
    await relayCaptureTaskCancellation(session, 'source_tab_removed');
    try {
      await releaseCaptureTaskResourcesWithRetry(
        {
          taskId: session.taskId,
          reason: 'source_tab_removed',
          debugSnapshot: session,
        },
        {attempts: 3},
      );
    } catch (error) {
      console.warn('[CaptureTask] source-tab cleanup remains pending:', error);
    }
    return;
  }
  await captureDebugSessionManager.handleTabRemoved(tabId);
  await captureTaskTabGroupManager.handleTabRemoved(tabId);
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  const resetObservedAccounts =
    reason === 'install' || reason === 'update'
      ? chrome.storage.local
          .remove(STORAGE_KEYS.observedSocialAccounts)
          .catch(() => {})
      : Promise.resolve();
  if (reason === 'install') {
    chrome.storage.local.remove('onstarvoice.riskNoticeAcknowledged').catch(() => {});
  }
  resetObservedAccounts
    .then(() => ensureRuntimeState())
    .catch((error) => {
      console.error('[onstarvoice] failed to initialize runtime on install', error);
    });
  reconcileUnattendedKeywordPlanSchedule({ launchDue: false })
    .catch((error) => {
      console.error('[onstarvoice] failed to sync unattended alarm on install', error);
    });
  syncUnattendedSupervisorAlarm().catch((error) => {
    console.error('[onstarvoice] failed to sync unattended supervisor on install', error);
  });
  syncCloudTaskAgentAlarm()
    .then(() => resetObservedAccounts)
    .then(() => syncCloudTaskAgent({reason: 'extension_installed', force: true}))
    .catch((error) => {
      console.error('[onstarvoice] failed to initialize cloud task agent on install', error);
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
  syncCloudTaskAgentAlarm()
    .then(() => syncCloudTaskAgent({reason: 'browser_startup', force: true}))
    .catch((error) => {
      console.error('[onstarvoice] failed to initialize cloud task agent on startup', error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === CLOUD_TASK_AGENT_ALARM_NAME) {
    syncCloudTaskAgentLiveness({reason: 'cloud_agent_alarm'}).catch((error) => {
      console.error('[onstarvoice] cloud task agent liveness failed', error);
    });
    syncCloudTaskAgent({reason: 'cloud_agent_alarm', force: true}).catch((error) => {
      console.error('[onstarvoice] cloud task agent heartbeat failed', error);
    });
    return;
  }
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

chrome.storage.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.auth]) return;
  const previousAgentId = String(
    changes[STORAGE_KEYS.auth]?.oldValue?.captureAgent?.id || '',
  );
  const nextAgentId = String(
    changes[STORAGE_KEYS.auth]?.newValue?.captureAgent?.id || '',
  );
  const previousToken = String(
    changes[STORAGE_KEYS.auth]?.oldValue?.captureAgent?.token || '',
  );
  const nextToken = String(
    changes[STORAGE_KEYS.auth]?.newValue?.captureAgent?.token || '',
  );
  if (
    !nextAgentId ||
    !nextToken ||
    (nextAgentId === previousAgentId && nextToken === previousToken)
  ) return;
  clearCloudTaskAgentFailureBackoff();
  syncCloudTaskAgent({reason: 'agent_credential_updated', force: true}).catch(
    (error) => {
      console.error('[onstarvoice] cloud task agent credential sync failed', error);
    },
  );
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
  if (changeInfo.frozen === true || changeInfo.discarded === true) {
    // Chromium 132+ 会明确暴露 frozen；Edge 的睡眠标签页也可能进一步
    // discarded。frozen 优先激活原 runner 解冻，避免重新执行当前关键词；
    // discarded 已卸载页面，才由 supervisor 从检查点重建。
    superviseUnattendedKeywordRun({
      reason: 'runner_tab_state_changed',
    }).catch((error) => {
      console.error('[onstarvoice] unattended runner state check failed', error);
    });
  }
  if (!tab?.active) return;
  if (!changeInfo.url && changeInfo.status !== 'complete') return;

  syncRuntimeForTabId(tabId, changeInfo.url || tab.url || '').catch((error) => {
    console.warn('[onstarvoice] failed to sync runtime on tab update', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleCaptureRuntimeTabRemoved(tabId).catch((error) => {
    console.warn('[onstarvoice] capture task tab cleanup failed', error);
  });
  superviseUnattendedKeywordRun({
    removedTabId: tabId,
    reason: 'runner_tab_removed',
  }).catch((error) => {
    console.error('[onstarvoice] unattended runner removal check failed', error);
  });
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  handleCaptureRuntimeTabReplaced(addedTabId, removedTabId).catch((error) => {
    console.warn('[onstarvoice] capture task tab migration failed', error);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  captureTaskOwnerCoordinator.attachPort(port);
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
            if (normalizedProgress.heartbeatOnly === true) {
              sendResponse({
                ok: true,
                data: {heartbeatOnly: true},
              });
              return;
            }
          }
          const progressPatch = runtimeTabPolicy.buildCaptureProgressPatch(
            sender?.tab,
            normalizedProgress,
          );
          const next = await writeRuntimeState({
            ...progressPatch,
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

        if (!runtimeTabPolicy.shouldAdoptPageState(sender?.tab)) {
          const current = await readRuntimeState();
          sendResponse({
            ok: true,
            data: {
              ignoredInactiveTab: true,
              platform: current.platform,
              pageType: current.pageType,
              detailReady: current.detailReady,
              detailReadyReason: current.detailReadyReason,
              lastPageUrl: current.lastPageUrl,
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

      if (type === 'onstarvoice:clear-task-center') {
        const result = await clearTaskCenterRecords();
        sendResponse({ok: true, data: result});
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

      if (type === 'onstarvoice:get-unattended-keyword-run-state') {
        const request = await readUnattendedKeywordRunRequest();
        sendResponse({ok: true, data: request});
        return;
      }

      if (type === 'onstarvoice:get-targeted-post-run-state') {
        const request = await readTargetedPostRunRequest();
        const requestId = String(message?.requestId || '').trim();
        const attemptId = String(message?.attemptId || '').trim();
        if (!requestId) {
          // 任务中心只读展示保持兼容；真正的运行页必须同时绑定
          // requestId 与 attemptId，避免旧页面读取到新一轮任务。
          sendResponse({ok: true, accepted: true, data: request});
          return;
        }
        if (!attemptId) {
          sendResponse({
            ok: false,
            accepted: false,
            reason: 'targeted_post_attempt_required',
            data: request,
          });
          return;
        }
        if (
          !request ||
          request.id !== requestId ||
          String(request.attemptId || '') !== attemptId
        ) {
          sendResponse({
            ok: false,
            accepted: false,
            reason: 'stale_targeted_post_attempt',
            data: request,
          });
          return;
        }
        sendResponse({
          ok: true,
          accepted: true,
          reason: '',
          data: request,
        });
        return;
      }

      if (type === 'onstarvoice:update-targeted-post-run') {
        const requestId = String(message?.requestId || '').trim();
        const attemptId = String(message?.attemptId || '').trim();
        const result = await runTargetedPostRunMutation(async () => {
          const request = await readTargetedPostRunRequest({
            persistNormalized: false,
          });
          if (!attemptId) {
            return {
              ok: false,
              accepted: false,
              reason: 'targeted_post_attempt_required',
              data: request,
            };
          }
          if (
            !request ||
            request.id !== requestId ||
            String(request.attemptId || '') !== attemptId
          ) {
            return {
              ok: false,
              accepted: false,
              reason: 'stale_targeted_post_attempt',
              data: request,
            };
          }
          if (cloudTargetedPostApi.isTerminalRunStatus(request.status)) {
            return {
              ok: false,
              accepted: false,
              reason: 'targeted_post_run_terminal',
              data: request,
            };
          }
          const next = cloudTargetedPostApi.mergeRunPatch(
            request,
            message?.patch,
          );
          const persisted = await persistTargetedPostRunRequest(next);
          return {
            ok: true,
            accepted: true,
            reason: '',
            data: persisted,
          };
        });
        let cloudReport = null;
        let runnerCleanup = null;
        if (
          result.ok &&
          cloudTargetedPostApi.isTerminalRunStatus(result.data?.status)
        ) {
          // 终态不能只依赖一个随后触发的计时器：MV3 Service Worker
          // 可能在计时器执行前休眠。直接等待指令回执，确保云端工作项、
          // 父任务和帖子可用性在同一次消息生命周期内完成结算。
          cloudReport = await reportTargetedPostTerminalToCloud(result.data);
          // 运行页只能在终态 request 与任务账本已经原子落盘、终态报告
          // 已完成本地记账/云端尝试之后关闭。needs_action 必须保留现场，
          // 且清理始终按 requestId + attemptId 精确匹配任务自有 shell。
          runnerCleanup = await closeTerminalTargetedPostRunnerTabs(
            result.data,
          );
        }
        sendResponse({
          ...result,
          cloudReported: cloudReport?.ok === true,
          runnerClosed: Number(runnerCleanup?.removedCount) > 0,
        });
        return;
      }

      if (type === 'onstarvoice:save-unattended-keyword-plan') {
        const plan = await saveUnattendedKeywordPlan(message?.plan || {}, {
          confirmCloudScope: true,
        });
        sendResponse({ ok: true, data: plan });
        return;
      }

      if (type === 'onstarvoice:claim-unattended-keyword-run') {
        const requestId = String(message?.requestId || '').trim();
        const result = await claimUnattendedKeywordRun({
          requestId,
          attemptId: String(message?.attemptId || '').trim(),
          requireAttempt: Boolean(requestId),
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

      if (type === 'onstarvoice:finalize-unattended-local-closure') {
        const result = await reconcileUnattendedLocalClosureEvidence({
          expectedRequestId: String(message?.requestId || '').trim(),
          expectedAttemptId: String(message?.attemptId || '').trim(),
          closeOwnedRunnerTabs: true,
        });
        if (result?.persisted === true) {
          scheduleCloudTaskAgentSync('unattended_local_closure_persisted', 0);
        }
        sendResponse({
          ok: result?.persisted === true || result?.reason === 'already_persisted',
          accepted:
            result?.persisted === true || result?.reason === 'already_persisted',
          reason: result?.reason || 'local_closure_unavailable',
          data: result?.evidence || null,
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
          '用户手动中止当前采集任务';
        const result = await cancelUnattendedKeywordRunFromControl({
          requestId: String(message?.requestId || '').trim(),
          message: reason,
          tabId: message?.tabId,
        });
        sendResponse({
          ok: result.accepted,
          accepted: result.accepted,
          reason: result.reason,
          data: {
            request: result.request,
            plan: result.plan,
            relayedCount: result.relayedCount,
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

      if (type === 'onstarvoice:begin-capture-task') {
        const data = await beginCaptureTask(message, sender);
        sendResponse({ok: true, data});
        return;
      }

      if (type === 'onstarvoice:update-capture-task') {
        const data = await updateCaptureTask(message);
        sendResponse({ok: true, data});
        return;
      }

      if (type === 'onstarvoice:register-capture-task-tab') {
        const data = await registerCaptureTaskTab(message, sender);
        sendResponse({ok: true, data});
        return;
      }

      if (type === 'onstarvoice:end-capture-task') {
        const data = await endCaptureTask(message);
        sendResponse({ok: true, data});
        return;
      }

      if (type === 'onstarvoice:set-capture-task-minimized') {
        const data = await setCaptureTaskMinimized(message);
        sendResponse({ok: true, data});
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
        const progressPatch = runtimeTabPolicy.buildCaptureProgressPatch(
          sender?.tab,
          normalizedProgress,
        );
        const next = await writeRuntimeState({
          ...progressPatch,
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
        const requestedTabId = message?.tabId;
        if (typeof requestedTabId !== 'number') {
          throw new Error('invalid tabId');
        }

        const sourcePayload =
          message?.payload && typeof message.payload === 'object'
            ? message.payload
            : {};
        const contentAction = String(sourcePayload.action || '');
        const requestedTaskId = String(
          sourcePayload.taskId || sourcePayload.taskContext?.taskId || '',
        ).trim();
        let relayTabId = requestedTabId;
        let relayTab = null;
        try {
          relayTab = await chrome.tabs.get(relayTabId);
        } catch {
          const replacement = resolveCaptureTaskReplacementTab(
            requestedTabId,
            requestedTaskId,
          );
          if (replacement) {
            relayTabId = replacement.tabId;
            try {
              relayTab = await chrome.tabs.get(relayTabId);
            } catch {
              relayTab = null;
            }
          }
        }
        const existingDebugSession =
          captureDebugSessionManager.getSession(relayTabId);
        if (
          contentAction === 'cancelCapture' &&
          !existingDebugSession?.persistent
        ) {
          await captureDebugSessionManager.stopByTab(
            relayTabId,
            'user_cancel_requested',
          );
        }

        const platform = detectPlatformFromUrl(relayTab?.url || '');
        const isListCaptureAction =
          globalThis.OnStarvoiceCaptureDebugSession.isListCaptureAction(
            contentAction,
          );
        const supportedListPlatform =
          platform === 'xiaohongshu' || platform === 'douyin';
        let persistentRelayTaskId = '';
        if (existingDebugSession?.persistent && isListCaptureAction) {
          if (!supportedListPlatform) {
            throw createCaptureTaskError(
              'capture_task_platform_unsupported',
              '任务来源页已离开小红书或抖音，已拒绝继续浏览器接管',
            );
          }
          if (
            existingDebugSession.platform &&
            existingDebugSession.platform !== platform
          ) {
            throw createCaptureTaskError(
              'capture_task_platform_mismatch',
              '任务来源页平台已变化，已拒绝继续浏览器接管',
            );
          }
          persistentRelayTaskId = String(
            sourcePayload.taskId || sourcePayload.taskContext?.taskId || '',
          ).trim();
          if (
            !persistentRelayTaskId ||
            persistentRelayTaskId !== existingDebugSession.taskId
          ) {
            throw createCaptureTaskError(
              'capture_task_relay_mismatch',
              '列表采集子运行与当前浏览器接管任务不一致',
            );
          }
        }
        const debugEligible =
          supportedListPlatform && isListCaptureAction;
        let debugSession = null;
        let debugSessionStartedByRelay = false;
        let relayPayload = sourcePayload;
        if (debugEligible) {
          const listRunId =
            globalThis.OnStarvoiceCaptureDebugSession.resolveListRelayRunId(
              sourcePayload.listCaptureRunId,
              createUuid,
            );
          if (existingDebugSession?.persistent) {
            if (listRunId === persistentRelayTaskId) {
              throw createCaptureTaskError(
                'list_capture_run_id_conflict',
                '列表子运行编号不能复用任务编号',
              );
            }
            debugSession = await captureDebugSessionManager.updateTask({
              taskId: existingDebugSession.taskId,
              activeListRunId: listRunId,
            });
          } else {
            const label =
              contentAction === 'captureKeywordNotes'
                ? sourcePayload.keyword
                  ? `搜索「${String(sourcePayload.keyword).slice(0, 48)}」`
                  : '搜索结果采集'
                : '博主作品采集';
            debugSession = await captureDebugSessionManager.start({
              tabId: relayTabId,
              runId: listRunId,
              label,
              pageTitle: relayTab?.title || '',
              pageUrl: relayTab?.url || '',
              platform,
            });
            debugSessionStartedByRelay = !existingDebugSession;
          }
          relayPayload = {
            ...sourcePayload,
            listCaptureRunId: listRunId,
          };
        }

        let response;
        let relayError = null;
        try {
          response = await relayToContentWithRetry(relayTabId, relayPayload);
        } catch (error) {
          relayError = error;
          throw error;
        } finally {
          if (debugSession && debugSessionStartedByRelay) {
            await captureDebugSessionManager.stop({
              tabId: relayTabId,
              runId: debugSession.runId,
              reason: 'capture_relay_finished',
            });
          }
          try {
            await recordSocialAccountUsageFromRelay({
              tab: relayTab,
              action: contentAction,
              platform,
              response,
              error: relayError,
              sourcePayload,
            });
          } catch (usageError) {
            console.warn(
              '[SocialAccountUsage] failed to record relay usage:',
              usageError,
            );
          }
        }
        const runtimePatch = runtimeTabPolicy.buildRelayRuntimePatch(relayTab);
        if (Object.keys(runtimePatch).length > 0) {
          await writeRuntimeState(runtimePatch);
        }
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
          ...(error?.details &&
          typeof error.details === 'object' &&
          !Array.isArray(error.details)
            ? {details: error.details}
            : {}),
        },
      });
    }
  })();

  return true;
});
