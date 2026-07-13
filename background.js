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
const CAPTURE_EXECUTION_LOCK_TTL_MS = 12 * 60 * 60 * 1000;
const UNATTENDED_RUN_CLAIM_GRACE_MS = 2 * 60 * 1000;
const UNATTENDED_RUN_ACTIVE_GRACE_MS = 5 * 60 * 1000;
const UNATTENDED_RUN_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'canceled',
  'skipped',
]);
let unattendedKeywordAlarmInFlight = false;
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

  const runnerTabId = Number(request.runnerTabId);
  if (Number.isFinite(runnerTabId) && runnerTabId > 0) {
    try {
      await chrome.tabs.get(runnerTabId);
      return true;
    } catch {
      return false;
    }
  }

  const timestamp =
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
  return Date.now() - timestamp <= graceMs;
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

async function releaseUnattendedKeywordPlanLock({ includeLegacyManualBatch = false } = {}) {
  const activeLock = await readActiveCaptureExecutionLock();
  const owner = String(activeLock?.owner || '');
  if (
    !activeLock ||
    (
      owner !== 'unattended_keyword_plan' &&
      !(includeLegacyManualBatch && owner === 'manual_batch_keyword_capture')
    )
  ) {
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

function normalizeCaptureExecutionLock(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const expiresAt = Number(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }
  return {
    id: String(value.id || ''),
    owner: String(value.owner || 'unknown'),
    label: String(value.label || '正在运行的采集任务'),
    startedAt: String(value.startedAt || ''),
    updatedAt: String(value.updatedAt || ''),
    expiresAt,
  };
}

async function readActiveCaptureExecutionLock() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.captureExecutionLock);
  const activeLock = normalizeCaptureExecutionLock(
    stored[STORAGE_KEYS.captureExecutionLock],
  );
  if (!activeLock && stored[STORAGE_KEYS.captureExecutionLock]) {
    await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock).catch(() => {});
  }
  return activeLock;
}

async function acquireCaptureExecutionLock({
  owner = 'unknown',
  label = '采集任务',
  ttlMs = CAPTURE_EXECUTION_LOCK_TTL_MS,
} = {}) {
  const activeLock = await readActiveCaptureExecutionLock();
  if (activeLock) {
    return {
      ok: false,
      lock: activeLock,
    };
  }

  const now = Date.now();
  const lock = {
    id: createUuid(),
    owner: String(owner || 'unknown'),
    label: String(label || '采集任务'),
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + Math.max(60 * 1000, Number(ttlMs) || CAPTURE_EXECUTION_LOCK_TTL_MS),
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.captureExecutionLock]: lock,
  });
  return {
    ok: true,
    lock,
  };
}

async function releaseCaptureExecutionLock(lockId = '') {
  const activeLock = await readActiveCaptureExecutionLock();
  if (!activeLock) {
    return true;
  }
  if (lockId && activeLock.id !== lockId) {
    return false;
  }
  await chrome.storage.local.remove(STORAGE_KEYS.captureExecutionLock);
  return true;
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
        await releaseCaptureExecutionLock(activeLock.id);
        activeLock = null;
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

async function writeRuntimeState(patch) {
  const current = await readRuntimeState();
  const next = {
    ...current,
    ...patch,
  };

  await chrome.storage.local.set({
    [STORAGE_KEYS.runtime]: next,
  });

  return next;
}

async function ensureRuntimeState() {
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

  return writeRuntimeState(nextPatch);
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

async function relayToContentWithRetry(tabId, payload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload ?? {});
    } catch (error) {
      if (!isTransientContentRelayError(error) || attempt === 1) {
        throw error;
      }

      await waitForTabReady(tabId).catch(() => null);
      await ensureContentScriptReady(tabId);
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
  }

  throw new Error('failed to relay message to content script');
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
          const next = await writeRuntimeState({
            lastActiveTabId: sender?.tab?.id ?? null,
            lastCaptureProgress: message?.progress ?? null,
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
        if (
          request.status === 'claimed' &&
          (await isUnattendedRunRequestActive(request))
        ) {
          sendResponse({ ok: true, data: null });
          return;
        }
        if (
          request.status !== 'pending' &&
          request.status !== 'claimed'
        ) {
          sendResponse({ ok: true, data: null });
          return;
        }

        const nextRequest = {
          ...request,
          status: 'claimed',
          claimedAt: request.claimedAt || new Date().toISOString(),
          runnerTabId: sender?.tab?.id ?? request.runnerTabId ?? null,
          updatedAt: new Date().toISOString(),
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
        await releaseUnattendedKeywordPlanLock({ includeLegacyManualBatch: true });

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
          ttlMs: message?.ttlMs,
        });
        sendResponse({ ok: result.ok, data: result.lock });
        return;
      }

      if (type === 'onstarvoice:release-capture-lock') {
        const released = await releaseCaptureExecutionLock(message?.lockId);
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
        const next = await writeRuntimeState({
          lastActiveTabId: sender?.tab?.id ?? null,
          lastCaptureProgress: message?.payload ?? null,
        });
        sendResponse({
          ok: true,
          data: {
            lastCaptureProgress: next.lastCaptureProgress,
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
          code: 'runtime_error',
          message: error instanceof Error ? error.message : 'unknown runtime error',
        },
      });
    }
  })();

  return true;
});
