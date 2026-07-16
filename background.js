const STORAGE_KEYS = {
  runtime: 'onstarvoice.runtime',
  unattendedKeywordPlan: 'onstarvoice.unattendedKeywordPlan',
  unattendedKeywordRunRequest: 'onstarvoice.unattendedKeywordRunRequest',
  captureExecutionLock: 'onstarvoice.captureExecutionLock',
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
const UNATTENDED_RUN_ACTIVE_GRACE_MS = 5 * 60 * 1000;
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
  'failed',
  'canceled',
  'skipped',
]);
let unattendedKeywordAlarmInFlight = false;
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

async function readUnattendedKeywordRunRequest() {
  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.unattendedKeywordRunRequest,
  );
  const request = stored[STORAGE_KEYS.unattendedKeywordRunRequest];
  return request && typeof request === 'object' ? request : null;
}

function isTerminalUnattendedRunStatus(status) {
  return UNATTENDED_RUN_TERMINAL_STATUSES.has(String(status || ''));
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : NaN;
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
  if (
    !request ||
    typeof request !== 'object' ||
    isTerminalUnattendedRunStatus(request.status)
  ) {
    return;
  }

  const nextRequest = {
    ...request,
    status: 'failed',
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message,
    error: {
      message,
    },
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.unattendedKeywordRunRequest]: nextRequest,
  });
}

async function cancelUnattendedKeywordRunRequest(message) {
  const request = await readUnattendedKeywordRunRequest();
  if (
    !request ||
    typeof request !== 'object' ||
    isTerminalUnattendedRunStatus(request.status)
  ) {
    return null;
  }

  const nextRequest = {
    ...request,
    status: 'canceled',
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.unattendedKeywordRunRequest]: nextRequest,
  });
  return nextRequest;
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
      await Promise.race([
        relayToContentWithRetry(tabId, { action: 'cancelCapture' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('cancel relay timeout')), 5000),
        ),
      ]);
      successCount += 1;
    } catch (error) {
      console.warn('[Background] Relay unattended cancel failed:', tabId, error);
    }
  }
  return successCount;
}

async function releaseUnattendedKeywordPlanLock() {
  const activeLock = await readActiveCaptureExecutionLock();
  const owner = String(activeLock?.owner || '');
  if (!activeLock || owner !== 'unattended_keyword_plan') {
    return false;
  }
  return await releaseCaptureExecutionLock(activeLock.id);
}

async function cleanupDisabledUnattendedKeywordPlanRuntime() {
  const message = '无人值守计划已关闭，已取消未完成任务';
  await cancelUnattendedKeywordRunRequest(message);
  await releaseUnattendedKeywordPlanLock();
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
  { recomputeNext = true, from = null } = {},
) {
  const normalized = normalizeUnattendedKeywordPlan({
    ...plan,
    updatedAt: new Date().toISOString(),
  });
  const nextRunAt = recomputeNext
    ? computeNextUnattendedRunAt(normalized, normalizeScheduleReference(from))
    : normalized.nextRunAt;
  const nextPlan = {
    ...normalized,
    nextRunAt,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.unattendedKeywordPlan]: nextPlan,
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
  if (lock?.holderTabId) {
    await relayCancelToTabs([lock.holderTabId]).catch(() => 0);
  }
  await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
  console.warn('[Background] Removed stale capture execution lock:', {
    id: lock?.id || '',
    owner: lock?.owner || 'unknown',
    reason,
  });
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
    await removeStaleCaptureExecutionLock(activeLock, 'lease_expired');
    return null;
  }

  const holderState = await getCaptureExecutionLockHolderState(activeLock);
  if (holderState === 'gone') {
    await removeStaleCaptureExecutionLock(activeLock, 'holder_document_gone');
    return null;
  }
  return activeLock;
}

async function readActiveCaptureExecutionLock() {
  return await runCaptureExecutionLockOperation(
    readActiveCaptureExecutionLockUnsafe,
  );
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
  const request = {
    id: createUuid(),
    type: 'keyword_batch',
    status: 'pending',
    reason,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    planSnapshot: normalizeUnattendedKeywordPlan(plan),
    progress: null,
    error: null,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.unattendedKeywordRunRequest]: request,
  });
  return request;
}

async function launchUnattendedKeywordRun(plan, { reason = 'alarm' } = {}) {
  const normalizedPlan = normalizeUnattendedKeywordPlan(plan);
  if (!normalizedPlan.enabled || normalizedPlan.keywords.length === 0) {
    return null;
  }

  const platformTab = await activateOrCreatePlatformTab(normalizedPlan.platform);
  const request = await createUnattendedKeywordRunRequest(normalizedPlan, {
    reason,
  });
  await openUnattendedRunnerTab(request.id, {
    windowId: platformTab?.windowId,
  });
  return request;
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

    let activeLock = await readActiveCaptureExecutionLock();
    if (activeLock) {
      const lockState = await resolveUnattendedPlanLockState(activeLock);
      if (lockState.type === 'stale_unattended') {
        await releaseCaptureExecutionLock(activeLock.id);
        await markUnattendedRunRequestStale(
          lockState.request,
          '无人值守任务已失去运行页面，已清理旧锁并准备重跑',
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
          {recomputeNext: false},
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
});

chrome.runtime.onStartup.addListener(() => {
  ensureRuntimeState().catch((error) => {
    console.error('[onstarvoice] failed to initialize runtime on startup', error);
  });
  reconcileUnattendedKeywordPlanSchedule({ launchDue: true })
    .catch((error) => {
      console.error('[onstarvoice] failed to sync unattended alarm on startup', error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== UNATTENDED_KEYWORD_ALARM_NAME) {
    return;
  }
  handleUnattendedKeywordAlarm().catch((error) => {
    console.error('[onstarvoice] unattended keyword alarm failed', error);
  });
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
        const stored = await chrome.storage.local.get(
          STORAGE_KEYS.unattendedKeywordRunRequest,
        );
        const request = stored[STORAGE_KEYS.unattendedKeywordRunRequest];
        if (!request || (requestId && request.id !== requestId)) {
          sendResponse({ ok: true, data: null });
          return;
        }
        const senderTabId = Number(sender?.tab?.id);
        const isSameRunnerTab =
          Boolean(requestId) &&
          Number.isFinite(senderTabId) &&
          senderTabId > 0 &&
          Number(request.runnerTabId) === senderTabId;
        const isSameRunnerResume =
          isSameRunnerTab &&
          new Set(['claimed', 'started', 'running']).has(
            String(request.status || ''),
          );
        if (
          request.status !== 'pending' &&
          (await isUnattendedRunRequestActive(request)) &&
          !isSameRunnerResume
        ) {
          sendResponse({ ok: true, data: null });
          return;
        }
        if (
          request.status !== 'pending' &&
          request.status !== 'claimed' &&
          !isSameRunnerResume
        ) {
          sendResponse({ ok: true, data: null });
          return;
        }

        const claimedAt = new Date().toISOString();
        const nextRequest = {
          ...request,
          status: 'claimed',
          claimedAt,
          heartbeatAt: claimedAt,
          runnerTabId: sender?.tab?.id ?? request.runnerTabId ?? null,
          updatedAt: claimedAt,
          resumeCount: isSameRunnerResume
            ? Math.max(0, Number(request.resumeCount) || 0) + 1
            : Math.max(0, Number(request.resumeCount) || 0),
          message: isSameRunnerResume
            ? '检测到运行页刷新，正在从已有采集数据恢复任务'
            : request.message,
        };
        await chrome.storage.local.set({
          [STORAGE_KEYS.unattendedKeywordRunRequest]: nextRequest,
        });
        sendResponse({ ok: true, data: nextRequest });
        return;
      }

      if (type === 'onstarvoice:update-unattended-keyword-run') {
        const requestId = String(message?.requestId || '').trim();
        const patch =
          message?.patch && typeof message.patch === 'object'
            ? message.patch
            : {};
        const stored = await chrome.storage.local.get(
          STORAGE_KEYS.unattendedKeywordRunRequest,
        );
        const request = stored[STORAGE_KEYS.unattendedKeywordRunRequest];
        if (!request || (requestId && request.id !== requestId)) {
          sendResponse({ ok: true, data: null });
          return;
        }
        if (isTerminalUnattendedRunStatus(request.status)) {
          sendResponse({ ok: true, data: request });
          return;
        }

        const nextRequest = {
          ...request,
          ...patch,
          id: request.id,
          updatedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({
          [STORAGE_KEYS.unattendedKeywordRunRequest]: nextRequest,
        });

        const mirroredStatus = new Set([
          'started',
          'running',
          'completed',
          'failed',
          'canceled',
          'skipped',
        ]);
        if (mirroredStatus.has(String(nextRequest.status || ''))) {
          const plan = await readUnattendedKeywordPlan();
          const isTerminalStatus = isTerminalUnattendedRunStatus(nextRequest.status);
          const nextPlan = normalizeUnattendedKeywordPlan({
            ...plan,
            lastRunAt:
              String(
                isTerminalStatus
                  ? nextRequest.finishedAt || nextRequest.updatedAt || ''
                  : nextRequest.updatedAt || nextRequest.startedAt || '',
              ) ||
              String(nextRequest.updatedAt || '') ||
              new Date().toISOString(),
            lastRunStatus: String(nextRequest.status || ''),
            lastRunMessage:
              String(nextRequest.message || '') ||
              String(nextRequest.error?.message || '') ||
              '',
            lastRunProgress: isTerminalStatus
              ? null
              : normalizeUnattendedRunProgress(
                  nextRequest.progress,
                  nextRequest.message,
                ),
            updatedAt: new Date().toISOString(),
          });
          await chrome.storage.local.set({
            [STORAGE_KEYS.unattendedKeywordPlan]: nextPlan,
          });
        }

        sendResponse({ ok: true, data: nextRequest });
        return;
      }

      if (type === 'onstarvoice:cancel-unattended-keyword-run') {
        const reason =
          String(message?.message || '').trim() ||
          '用户手动中止无人值守计划';
        const request = await readUnattendedKeywordRunRequest();
        const progress = normalizeUnattendedRunProgress(
          request?.progress,
          request?.message,
        );
        const explicitTabId = Number(message?.tabId);
        const progressRunnerTabId = Number(progress?.runnerTabId);
        const canceledRequest = await cancelUnattendedKeywordRunRequest(reason);
        const relayedCount = await relayCancelToTabs([
          explicitTabId,
          progressRunnerTabId,
        ]);
        await releaseUnattendedKeywordPlanLock();

        const now = new Date();
        const plan = await readUnattendedKeywordPlan();
        const nextPlan = await saveUnattendedKeywordPlan(
          {
            ...plan,
            lastRunAt: now.toISOString(),
            lastRunStatus: 'canceled',
            lastRunMessage: reason,
            lastRunProgress: null,
            nextRunAt: '',
          },
          { recomputeNext: true, from: buildScheduleReferenceAfterDate(now) },
        );

        sendResponse({
          ok: true,
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
