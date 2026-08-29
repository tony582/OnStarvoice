/**
 * onstarvoice V2.0 Capture & Sync Integration Module
 * 采集与同步集成层 - M4 插件与后端接通
 *
 * 本模块负责：
 * 1. 调用采集模块获取数据
 * 2. 将采集结果入池（dataPool）
 * 3. 调用后端 API 同步数据
 * 4. 更新同步状态
 */

import { sync, syncBatch, checkCapturedExternalIds } from './api.js';

import {
  addRecord,
  addRecords,
  addSyncHistoryEntry,
  getDataPool,
  getRecord,
  getRecords,
  runDataPoolMutation,
  setDataPool,
  updateRecord,
  markRecordSynced,
  getAuth,
  getTarget,
  getRuntime,
  updateCapture,
  updateRuntime,
  updateSync,
  resetCapture,
  resetSync,
  deleteRecord,
} from './storage.js';

import {
  SYNC_TYPE,
  CAPTURE_STATUS,
  SYNC_STATUS,
  RECORD_STATUS,
  ERROR_REASON,
  MESSAGE_TYPE,
  PAGE_TYPE,
} from './constants.js';
import { getCaptureSettings } from './capture-settings.js';
import { extractNoteId, detectPageType, detectPlatformFromUrl } from './helpers.js';
import { createRecordEnvelope } from './platform/record-envelope.js';
import {
  buildSyncHistoryTarget,
  buildSyncInput as buildPlatformSyncInput,
  resolveSyncTableName,
} from './platform/sync-router.js';
import { parseInteractionCount } from './helpers.js';
import {appendTaskContext, getActiveTaskContext} from './task-context.js';
import {
  recordDiagnosticAction,
  recordDiagnosticError,
  recordDiagnosticStage,
} from './diagnostics.js';
import {buildDetailEnhanceStage} from './capture/stage-diagnostics.js';
import {
  DETAIL_RUNNER_MODE,
  closeOwnedDetailRunnerTab,
  closeOwnedDetailRunnerTabs,
  createDedicatedDetailRunnerTab,
  normalizeDetailRunnerMode,
} from './capture/detail-runner.js';
import {createDetailPrefetchPipeline} from './capture/detail-prefetch-pipeline.js';
import {
  clearInterruptedCommentObservation,
  repairInterruptedCommentPayload,
} from './capture-recovery.js';
import {
  createCaptureRequestId,
  ensureCommentCaptureIdentity,
} from './capture-request.js';
import {
  dedupeNormalizedCommentItems,
  resolveCommentMergeLimit,
} from './comment-dedupe.js';
import {isUnattendedSafetyBlock} from './unattended-keyword-run.js';
import {
  isDouyinOwnProfileUrl,
  pickDouyinAuthorName,
} from './capture/douyin-author.js';
import {
  createDouyinSearchServiceAbnormalError,
  createDouyinSearchSecurityChallengeError,
  DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE,
  DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE,
  isDouyinSearchServiceAbnormalError,
  isDouyinSearchSecurityChallengeError,
} from './capture/douyin-search-guard.js';
import {
  createXhsSecurityBlockError,
  XHS_SECURITY_PAGE_MARKERS,
} from './capture/xiaohongshu-security.js';
import {
  evaluateRelevancePrefilterRecords,
  RELEVANCE_PREFILTER_DEFAULT_THRESHOLD,
} from './capture/relevance-prefilter.js';
import './capture/target-page-availability.js';
// StarVoice 未启用福利中心（welfare-usage.js）；相关 welfare 埋点已移除，见下方 no-op。

const targetPageAvailabilityApi =
  globalThis.OnStarvoiceTargetPageAvailability;

const COMMENT_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  CAPTURING: 'capturing',
  DONE: 'done',
  PARTIAL: 'partial',
  FAILED: 'failed',
};

const DETAIL_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  CAPTURING: 'capturing',
  DONE: 'done',
  FILTERED: 'filtered',
  FAILED: 'failed',
};

const CAPTURE_TASK_MESSAGE_TYPE = Object.freeze({
  BEGIN: 'onstarvoice:begin-capture-task',
  UPDATE: 'onstarvoice:update-capture-task',
  REGISTER_TAB: 'onstarvoice:register-capture-task-tab',
  END: 'onstarvoice:end-capture-task',
});
const activeCaptureTaskSessions = new Map();
const CLOUD_CAPTURE_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function resolveActiveCloudCaptureTaskId(context = getActiveTaskContext()) {
  const rawTaskId = String(
    context?.metadata?.requestId || context?.taskId || '',
  ).trim();
  const taskId = rawTaskId.startsWith('unattended-capture:')
    ? rawTaskId.slice('unattended-capture:'.length)
    : rawTaskId;
  return CLOUD_CAPTURE_TASK_ID_PATTERN.test(taskId) ? taskId.toLowerCase() : '';
}

function buildCaptureTaskProgressActivityKey(progress = {}) {
  return [
    String(progress?.phase || ''),
    String(progress?.progressScope || ''),
    String(progress?.keyword || ''),
    Number(progress?.roundCurrent ?? progress?.round) || 0,
    Number(progress?.keywordCurrent) || 0,
    Number(progress?.itemCurrent ?? progress?.current) || 0,
    String(progress?.recordId || ''),
    Number(progress?.attemptCurrent ?? progress?.attempt) || 0,
  ].join('|');
}

function enrichCaptureTaskProgressTiming(session, progress = {}) {
  const now = Date.now();
  const updatedAt = new Date(now).toISOString();
  const activityKey = buildCaptureTaskProgressActivityKey(progress);
  if (
    !session.progressActivityKey ||
    session.progressActivityKey !== activityKey
  ) {
    session.progressActivityKey = activityKey;
    session.phaseStartedAt = updatedAt;
  }
  const phaseStartedAt =
    String(progress?.phaseStartedAt || session.phaseStartedAt || '').trim() ||
    updatedAt;
  session.phaseStartedAt = phaseStartedAt;
  session.lastProgressAt = updatedAt;
  return {
    ...(progress && typeof progress === 'object' ? progress : {}),
    phaseStartedAt,
    updatedAt,
  };
}

function normalizeCaptureTaskId(value) {
  return String(value || '').trim().slice(0, 120);
}

function normalizeCaptureTaskAttemptId(value) {
  return String(value || '').trim().slice(0, 160);
}

function resolveActiveCaptureTaskSession(taskId = '') {
  const normalizedTaskId = normalizeCaptureTaskId(taskId);
  if (!normalizedTaskId) return null;
  const session = activeCaptureTaskSessions.get(normalizedTaskId);
  return session?.state === 'active' ? session : null;
}

async function sendCaptureTaskLifecycleMessage(
  type,
  payload,
  {chromeApi = globalThis.chrome} = {},
) {
  if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== 'function') {
    return {ok: false, skipped: true, reason: 'runtime_unavailable'};
  }

  try {
    const response = await chromeApi.runtime.sendMessage({type, ...payload});
    if (response?.ok !== true) {
      return {
        ok: false,
        skipped: true,
        reason: String(response?.error?.code || 'task_session_unavailable'),
        response: response ?? null,
      };
    }
    return {ok: true, data: response.data ?? null};
  } catch (error) {
    console.debug(
      '[CaptureSync] capture task lifecycle message unavailable (ignored):',
      error?.message || error,
    );
    return {
      ok: false,
      skipped: true,
      reason: 'task_session_unavailable',
      error,
    };
  }
}

async function setCaptureTaskTakeoverStateInTab(
  {
    tabId = null,
    taskId = '',
    active = false,
    label = 'AI 正在接管',
    clearTrace = false,
  } = {},
  {chromeApi = globalThis.chrome} = {},
) {
  const normalizedTabId = Number(tabId);
  if (
    !Number.isSafeInteger(normalizedTabId) ||
    normalizedTabId <= 0 ||
    !chromeApi?.runtime ||
    typeof chromeApi.runtime.sendMessage !== 'function'
  ) {
    return false;
  }
  try {
    const response = await chromeApi.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: normalizedTabId,
      payload: {
        action: 'setCaptureTaskTakeover',
        taskId: normalizeCaptureTaskId(taskId),
        active: Boolean(active),
        label: String(label || 'AI 正在接管').trim().slice(0, 80),
        clearTrace: clearTrace === true,
      },
    });
    return response?.ok !== false && response?.data?.ok !== false;
  } catch (error) {
    console.debug(
      '[CaptureSync] capture task takeover update unavailable (ignored):',
      error?.message || error,
    );
    return false;
  }
}

export async function beginCaptureTaskSession(
  {
    taskId = '',
    tabId = null,
    label = '',
    platform = '',
    ownerRequired = false,
    attemptId = '',
  } = {},
  options = {},
) {
  const normalizedTaskId = normalizeCaptureTaskId(taskId);
  const normalizedAttemptId = normalizeCaptureTaskAttemptId(attemptId);
  const normalizedTabId = Number(tabId);
  if (
    !normalizedTaskId ||
    !Number.isSafeInteger(normalizedTabId) ||
    normalizedTabId <= 0
  ) {
    return {ok: false, skipped: true, reason: 'invalid_task_session'};
  }

  const existing = resolveActiveCaptureTaskSession(normalizedTaskId);
  if (
    existing &&
    existing.tabId === normalizedTabId &&
    String(existing.attemptId || '') === normalizedAttemptId
  ) {
    await setCaptureTaskTakeoverStateInTab(
      {
        tabId: existing.tabId,
        taskId: existing.taskId,
        active: true,
        label: existing.label || label,
      },
      options,
    );
    return {ok: true, active: true, reused: true, taskId: normalizedTaskId};
  }

  const beginPayload = {
    taskId: normalizedTaskId,
    tabId: normalizedTabId,
    label: String(label || '').trim().slice(0, 120),
    platform: String(platform || '').trim().toLowerCase().slice(0, 40),
    ownerRequired: ownerRequired === true,
    ...(normalizedAttemptId ? {attemptId: normalizedAttemptId} : {}),
  };
  let result = null;
  const retryDelays = existing ? [0, 120, 360, 720] : [0];
  for (const delayMs of retryDelays) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    result = await sendCaptureTaskLifecycleMessage(
      CAPTURE_TASK_MESSAGE_TYPE.BEGIN,
      beginPayload,
      options,
    );
    if (result.ok) break;
    if (
      !existing ||
      !new Set([
        'capture_task_source_mismatch',
        'capture_task_not_found',
        'capture_task_cleanup_pending',
      ]).has(String(result.reason || ''))
    ) {
      break;
    }
  }
  if (!result.ok) {
    return {...result, active: false, taskId: normalizedTaskId};
  }

  const session = existing || {
    taskId: normalizedTaskId,
    state: 'active',
  };
  session.tabId = normalizedTabId;
  session.label = beginPayload.label;
  session.platform = beginPayload.platform;
  session.attemptId = normalizedAttemptId;
  session.state = 'active';
  activeCaptureTaskSessions.set(normalizedTaskId, session);
  await setCaptureTaskTakeoverStateInTab(
    {
      tabId: normalizedTabId,
      taskId: normalizedTaskId,
      active: true,
      label: 'AI 正在接管',
    },
    options,
  );
  return {
    ...result,
    active: true,
    taskId: normalizedTaskId,
    ...(existing ? {reused: true, rebound: true} : {}),
  };
}

export async function updateCaptureTaskSession(
  {taskId = '', progress = {}} = {},
  options = {},
) {
  const session = resolveActiveCaptureTaskSession(taskId);
  if (!session) {
    return {ok: true, skipped: true, reason: 'no_active_task_session'};
  }

  const timedProgress = enrichCaptureTaskProgressTiming(session, progress);
  return await sendCaptureTaskLifecycleMessage(
    CAPTURE_TASK_MESSAGE_TYPE.UPDATE,
    {
      taskId: session.taskId,
      progress: timedProgress,
      ...(session.attemptId ? {attemptId: session.attemptId} : {}),
    },
    options,
  );
}

export async function registerCaptureTaskTab(
  {taskId = '', tabId = null, role = 'worker'} = {},
  options = {},
) {
  const normalizedTaskId = normalizeCaptureTaskId(taskId);
  const session = normalizedTaskId
    ? resolveActiveCaptureTaskSession(normalizedTaskId)
    : null;
  const normalizedTabId = Number(tabId);
  if (!session) {
    return {ok: true, skipped: true, reason: 'no_active_task_session'};
  }
  if (!Number.isSafeInteger(normalizedTabId) || normalizedTabId <= 0) {
    return {ok: false, skipped: true, reason: 'invalid_task_tab'};
  }

  return await sendCaptureTaskLifecycleMessage(
    CAPTURE_TASK_MESSAGE_TYPE.REGISTER_TAB,
    {
      taskId: session.taskId,
      tabId: normalizedTabId,
      role: String(role || 'worker').trim().toLowerCase().slice(0, 40),
      ...(session.attemptId ? {attemptId: session.attemptId} : {}),
    },
    options,
  );
}

export async function endCaptureTaskSession(
  {taskId = '', reason = 'completed', status = 'completed'} = {},
  options = {},
) {
  const session = resolveActiveCaptureTaskSession(taskId);
  if (!session) {
    return {ok: true, skipped: true, reason: 'no_active_task_session'};
  }

  session.state = 'ending';
  const endPayload = {
    taskId: session.taskId,
    reason: String(reason || 'completed').trim().slice(0, 120),
    status: String(status || 'completed').trim().slice(0, 80),
    ...(session.attemptId ? {attemptId: session.attemptId} : {}),
  };
  let result = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await sendCaptureTaskLifecycleMessage(
      CAPTURE_TASK_MESSAGE_TYPE.END,
      endPayload,
      options,
    );
    const terminallyAbsent =
      result?.reason === 'capture_task_not_found' ||
      result?.response?.error?.code === 'capture_task_not_found';
    if (result?.ok === true || terminallyAbsent || attempt === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const terminallyAbsent =
    result?.reason === 'capture_task_not_found' ||
    result?.response?.error?.code === 'capture_task_not_found';
  const staleAttemptIgnored = result?.data?.ignored === true;
  if (result?.ok === true || terminallyAbsent) {
    if (staleAttemptIgnored) {
      if (activeCaptureTaskSessions.get(session.taskId) === session) {
        activeCaptureTaskSessions.delete(session.taskId);
      }
      return result;
    }
    await setCaptureTaskTakeoverStateInTab(
      {
        tabId: session.tabId,
        taskId: session.taskId,
        active: false,
        label: 'AI 正在接管',
        clearTrace: true,
      },
      options,
    );
    if (activeCaptureTaskSessions.get(session.taskId) === session) {
      activeCaptureTaskSessions.delete(session.taskId);
    }
  } else {
    session.state = 'active';
  }
  return result;
}

function trackCoreCaptureSuccess(recordCount, metadata = {}) {
  // StarVoice 未启用福利中心：相关 welfare 埋点在此 no-op（保留函数壳，调用点不受影响）。
  void recordCount;
  void metadata;
}

function trackSyncSuccess(recordCount, metadata = {}) {
  // StarVoice 未启用福利中心：同上 no-op。
  void recordCount;
  void metadata;
}

const DETAIL_CAPTURE_FAILURE_CODE = {
  NONE: 'NONE',
  LINK_MISSING: 'LINK_MISSING',
  PAGE_OPEN_TIMEOUT: 'PAGE_OPEN_TIMEOUT',
  PAGE_OPEN_FAILED: 'PAGE_OPEN_FAILED',
  CONTENT_UNAVAILABLE: 'CONTENT_UNAVAILABLE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  NOTE_CAPTURE_FAILED: 'NOTE_CAPTURE_FAILED',
  COMMENTS_CAPTURE_FAILED: 'COMMENTS_CAPTURE_FAILED',
  BLOGGER_METRICS_FAILED: 'BLOGGER_METRICS_FAILED',
  CONTEXT_INTERRUPTED: 'CONTEXT_INTERRUPTED',
  CANCELED: 'CANCELED',
  INVALID_RECORD: 'INVALID_RECORD',
  UNKNOWN: 'UNKNOWN',
};

const DETAIL_CAPTURE_FAILURE_CATEGORY = {
  NONE: 'none',
  LINK_MISSING: 'link_missing',
  PAGE_FAILED: 'page_failed',
  INTEGRITY_BLOCKED: 'integrity_blocked',
  CONTEXT_INTERRUPTED: 'context_interrupted',
  USER_CANCELED: 'user_canceled',
  INVALID_RECORD: 'invalid_record',
  UNKNOWN: 'unknown',
};

const BLOGGER_METRICS_CAPTURE_STATUS = {
  NOT_STARTED: 'not_started',
  DONE: 'done',
  FAILED: 'failed',
};

const COMMENT_CONTENT_MAX_LENGTH = 280;
const DETAIL_CAPTURE_NAV_TIMEOUT_MS = 90000;
const DETAIL_CAPTURE_NAV_POLL_MS = 280;
const DETAIL_CAPTURE_AFTER_NAV_WAIT_MS = 2000;
const DOUYIN_UNAVAILABLE_GRACE_MS = 4500;
const DOUYIN_DETAIL_ROUTE_SETTLE_MS = 1200;
const DOUYIN_SEARCH_MODAL_BIND_GRACE_MS = 2500;
const DOUYIN_DETAIL_NAV_CANDIDATE_TIMEOUT_MS = 15000;
// 抖音同一作品依次尝试“作品直达链接 / 本记录自己的搜索弹层”。
// 这些候选必须共享总预算，不能每个候选都重新吃满超时，导致一条坏链接
// 把无人值守任务拖成分钟级假死。
const DOUYIN_DETAIL_NAV_TOTAL_TIMEOUT_MS = 55000;
const DOUYIN_DETAIL_READY_PROBE_TIMEOUT_MS = 20000;
const DOUYIN_COMMENT_READY_PROBE_TIMEOUT_MS = 1800;
const DOUYIN_COMMENT_RECOVERY_READY_TIMEOUT_MS = 8000;
// 补采详情「条与条之间」的随机间隔。注:小红书 300013 的真因是 xsec_source 为空(见
// ensureXhsNoteUrlSource),不是请求频率;这里保留小幅随机间隔做基本礼貌,不必拉长。
const DETAIL_ITEM_DELAY_MIN_MS = 2000;
const DETAIL_ITEM_DELAY_MAX_MS = 5000;
const DETAIL_PREFETCH_WORKER_COUNT = 2;
const DETAIL_PREFETCH_NAV_GAP_MS = 3000;
const DETAIL_PREFETCH_STOP_TIMEOUT_MS = 1500;
const DETAIL_RUNNER_RECREATE_MAX_PER_BATCH = 2;
const DETAIL_RUNNER_RECREATE_MAX_PER_ITEM = 1;
// 进博主主页前的小随机抖动:打散「笔记页 → 主页」的连续导航(burst 也是风控信号)。
const PROFILE_NAV_JITTER_MIN_MS = 1200;
const PROFILE_NAV_JITTER_MAX_MS = 3200;
// 博主主页「小红书号/抖音号」常 ~3.5s 才渲染,2s 太短会回退成内部 ID → 取号失败
const PROFILE_AFTER_NAV_WAIT_MS = 3500;
// 抖音号(douyinId)批量补采【总开关】。抖音号只在博主主页正文,补它要每个博主多跳一次主页,
// 会显著拖慢采集。客户当前不需要抖音号 → 默认关闭,= 完美回退到「不进主页」的原行为
// (零额外导航)。maybeAttachDouyinAccountNo 及两处 hook 代码完整保留,日后客户要号改回 true 即可。
const ENABLE_DOUYIN_ID_LOOKUP_ON_BATCH = false;
const DEFAULT_BLOGGER_PROFILE_TABLE_NAME = '博主信息表';
const DEFAULT_BLOGGER_NOTES_TABLE_NAME = '博主笔记采集';
const DEFAULT_KEYWORD_NOTES_TABLE_NAME = '关键词笔记采集';
const DEFAULT_COMMENT_LEADS_TABLE_NAME = 'comment_leads';
const MAX_SYNC_RECORDS_PER_BATCH = 500;
const MAX_SYNC_RECORDS_PER_REQUEST = 5;
const MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST = 1024 * 1024;
const MAX_SYNC_COMMENT_RICH_RECORDS_PER_REQUEST = 1;
const SYNC_COMMENT_RICH_RECORD_MIN_COMMENTS = 1;
const SYNC_LARGE_RECORD_BYTES_PER_REQUEST = 256 * 1024;
const SYNC_BATCH_REQUEST_SPACING_MS = 2000;
const SYNC_RATE_LIMIT_RETRY_ATTEMPTS = 2;
const SYNC_RATE_LIMIT_RETRY_BASE_DELAY_MS = 5000;
const SYNC_RATE_LIMIT_RETRY_MAX_DELAY_MS = 60000;
const RATE_LIMIT_SYNC_REASONS = new Set([
  'rate_limited',
  'too_many_requests',
  '429',
]);
const INDETERMINATE_SYNC_REASONS = new Set([
  'timeout',
  'network_error',
  'coze_timeout',
  'timeout_budget_exceeded',
  ERROR_REASON.TIMEOUT,
  ERROR_REASON.NETWORK_ERROR,
]);
const MAX_SYNC_REQUEST_PAYLOAD_BYTES = MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST;
const DEFAULT_CHECK_SYNC_TYPES = [
  SYNC_TYPE.SINGLE_NOTE,
  SYNC_TYPE.COMMENTS,
  SYNC_TYPE.KEYWORD_NOTES,
  SYNC_TYPE.BLOGGER_PROFILE,
  SYNC_TYPE.BLOGGER_NOTES,
];
const COMMENT_LEADS_ELIGIBLE_SYNC_TYPES = new Set([
  SYNC_TYPE.SINGLE_NOTE,
  SYNC_TYPE.COMMENTS,
  SYNC_TYPE.BLOGGER_NOTES,
  SYNC_TYPE.KEYWORD_NOTES,
]);
const FRONTEND_SYNC_FAILURE_REASON = 'FRONTEND_SYNC_FAILED';
const FRONTEND_SYNC_ERROR_MESSAGE_LIMIT = 600;
const FRONTEND_SYNC_ERROR_STACK_LINE_LIMIT = 8;
const FRONTEND_SYNC_HISTORY_ITEM_LIMIT = 50;
const LIST_CAPTURE_RECORD_TYPES = new Set([
  SYNC_TYPE.BLOGGER_NOTES,
  SYNC_TYPE.KEYWORD_NOTES,
]);

let activeListCaptureCheckpointSession = null;

function isListCaptureRecordType(type) {
  return LIST_CAPTURE_RECORD_TYPES.has(String(type || '').trim());
}

function applySyncPreferencesToPayload(payload = {}, captureSettings = {}) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  return {
    ...compactPayloadForBackendSync(safePayload),
    skipOfficialAccounts: captureSettings.skipOfficialAccounts !== false,
  };
}

function compactPayloadForBackendSync(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const next = {...source};
  const items = Array.isArray(source.items)
    ? source.items
        .filter((item) => item && typeof item === 'object')
        .map((item) => compactSyncItemForBackend(item))
    : [];

  if (items.length > 0) {
    next.items = items.slice(0, 1);
    // 已补采详情的记录,detailPayload 里才有完整正文/评论/博主指标/小红书号·抖音号。
    // 同步必须保留它,否则后端 sync 从 detailPayload 取不到这些(尤其号)→ 号永远是空。
    // 只有纯列表态(从没补采过详情)才删,避免 payload 膨胀。
    const dp = source.detailPayload;
    const hasDetailPayload =
      dp && typeof dp === 'object' && Object.keys(dp).length > 0;
    if (!hasDetailPayload) {
      delete next.detailPayload;
    }
  }

  delete next.detailCaptureDiagnosticMessage;
  delete next.detailCaptureFailureStage;
  delete next.detailCaptureFailureCategory;
  delete next.cardImageCandidates;
  delete next.cardVideoCandidates;
  delete next.domLocator;
  delete next.domMatchHints;

  return compactSyncItemForBackend(next);
}

// 去重并限制媒体直链数量，避免 payload 膨胀；只保留 http(s) 直链。
function trimMediaUrlList(list, primary = '', max = 3) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const url = String(value || '').trim();
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  push(primary);
  (Array.isArray(list) ? list : []).forEach(push);
  return out.slice(0, max);
}

function compactSyncItemForBackend(item = {}) {
  const next = item && typeof item === 'object' ? {...item} : {};

  // captureTrace 只用于扩展本地的「页面标记 ↔ 记录 ↔ 详情任务」寻址，
  // 不是后端业务字段。避免仅因 trace 状态变化扩大同步 payload。
  delete next.captureTrace;
  delete next.domLocator;
  delete next.domMatchHints;
  delete next.cardImageCandidates;
  delete next.cardVideoCandidates;
  delete next.mediaDiagnostics;
  delete next.detailDiagnostics;
  delete next.captureDiagnostics;

  // 保留媒体直链：后台「下载附件」依赖 videoUrl/audioUrl（封面+视频+音频）。
  // 之前这里整列清空导致采到的视频直链入库即丢，后台只能下封面。
  next.videoUrls = trimMediaUrlList(next.videoUrls, next.videoUrl);
  next.audioUrls = trimMediaUrlList(next.audioUrls, next.audioUrl);
  next.musicUrls = trimMediaUrlList(next.musicUrls, next.musicUrl);
  next.videoUrl = next.videoUrl || next.videoUrls[0] || '';
  next.audioUrl = next.audioUrl || next.audioUrls[0] || '';
  next.musicUrl = next.musicUrl || next.musicUrls[0] || '';

  return next;
}

function normalizeCaptureTraceSequence(value) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && !value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeCaptureTrace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const sequence = normalizeCaptureTraceSequence(value.sequence);
  const runId = String(value.runId || '').trim();
  const identityKey = String(value.identityKey || '').trim();
  if (sequence === null && !runId && !identityKey) {
    return null;
  }

  return {
    ...value,
    version: value.version ?? 1,
    runId,
    sequence,
    identityKey,
    state: String(value.state || '').trim(),
    recordId: String(value.recordId || '').trim(),
  };
}

function normalizeCompleteCaptureTrace(value) {
  const normalized = normalizeCaptureTrace(value);
  if (
    !normalized ||
    Number(normalized.version) !== 1 ||
    !normalized.runId ||
    normalized.sequence === null ||
    !normalized.identityKey ||
    !normalized.state
  ) {
    return null;
  }
  return normalized;
}

function selectBestCaptureTrace(candidates = []) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => normalizeCaptureTrace(candidate))
    .filter(Boolean);
  return (
    normalized.find((candidate) => normalizeCompleteCaptureTrace(candidate)) ||
    normalized[0] ||
    null
  );
}

function resolveCaptureTraceFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
  return selectBestCaptureTrace([
    payload.captureTrace,
    firstItem?.captureTrace,
  ]);
}

function resolveCaptureTraceFromRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  return selectBestCaptureTrace([
    record.captureTrace,
    resolveCaptureTraceFromPayload(record.payload),
    resolveCaptureTraceFromPayload(record.normalizedPayload),
    resolveCaptureTraceFromPayload(record.rawPayload),
    record.meta?.captureTrace,
  ]);
}

function bindCaptureTrace(trace, recordId, state = 'saved') {
  const normalized = normalizeCompleteCaptureTrace(trace);
  if (!normalized) {
    return null;
  }
  return {
    ...normalized,
    recordId: String(recordId || normalized.recordId || '').trim(),
    state: String(state || normalized.state || '').trim(),
  };
}

function applyCaptureTraceToPayload(payload, trace) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const normalized = normalizeCompleteCaptureTrace(trace);
  if (!normalized) {
    return source;
  }

  const next = {
    ...source,
    captureTrace: {...normalized},
  };
  if (Array.isArray(source.items) && source.items.length > 0) {
    next.items = source.items.map((item, index) =>
      index === 0 && item && typeof item === 'object'
        ? {...item, captureTrace: {...normalized}}
        : item,
    );
  }
  return next;
}

function applyCaptureTraceToRecord(record, trace) {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const normalized = normalizeCompleteCaptureTrace(trace);
  if (!normalized) {
    return record;
  }

  const nextPayload = applyCaptureTraceToPayload(
    record.payload || record.normalizedPayload,
    normalized,
  );
  const rawPayload =
    record.rawPayload && typeof record.rawPayload === 'object'
      ? record.rawPayload
      : {};
  const nextRawPayload =
    Object.keys(rawPayload).length > 0
      ? applyCaptureTraceToPayload(rawPayload, normalized)
      : rawPayload;
  return {
    ...record,
    rawPayload: nextRawPayload,
    normalizedPayload: nextPayload,
    payload: nextPayload,
  };
}

function buildCaptureTraceBinding(trace) {
  const normalized = normalizeCompleteCaptureTrace(trace);
  if (!normalized || !normalized.recordId) {
    return null;
  }
  return {
    version: normalized.version,
    runId: normalized.runId,
    sequence: normalized.sequence,
    identityKey: normalized.identityKey,
    recordId: normalized.recordId,
    state: normalized.state,
  };
}

function compareCaptureTraceBindings(left, right) {
  const leftSequence = normalizeCaptureTraceSequence(left?.sequence);
  const rightSequence = normalizeCaptureTraceSequence(right?.sequence);
  if (leftSequence !== null || rightSequence !== null) {
    if (leftSequence === null) return 1;
    if (rightSequence === null) return -1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  }
  const runCompare = String(left?.runId || '').localeCompare(
    String(right?.runId || ''),
  );
  if (runCompare !== 0) return runCompare;
  return String(left?.identityKey || '').localeCompare(
    String(right?.identityKey || ''),
  );
}

function mergeCaptureTraceBinding(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const sameRun =
    String(existing.runId || '') === String(incoming.runId || '');
  const sameIdentity =
    String(existing.identityKey || '') === String(incoming.identityKey || '');
  if (!sameRun || !sameIdentity) {
    return incoming;
  }
  const existingSequence = normalizeCaptureTraceSequence(existing.sequence);
  const incomingSequence = normalizeCaptureTraceSequence(incoming.sequence);
  return {
    ...existing,
    ...incoming,
    sequence:
      existingSequence !== null && incomingSequence !== null
        ? Math.min(existingSequence, incomingSequence)
        : incomingSequence ?? existingSequence,
  };
}

function sortCaptureTraceBindings(bindings = []) {
  const byRecordId = new Map();
  (Array.isArray(bindings) ? bindings : []).forEach((binding) => {
    const normalized = buildCaptureTraceBinding(binding);
    if (!normalized) return;
    const key = normalized.recordId;
    byRecordId.set(
      key,
      mergeCaptureTraceBinding(byRecordId.get(key), normalized),
    );
  });
  return [...byRecordId.values()].sort(compareCaptureTraceBindings);
}

function upsertCaptureTraceBindings(target, bindings = []) {
  if (!Array.isArray(target)) return [];
  const sorted = sortCaptureTraceBindings([...target, ...bindings]);
  target.splice(0, target.length, ...sorted);
  return target;
}

function orderRecordIdsByCaptureTrace(recordIds = [], bindings = []) {
  const uniqueRecordIds = [
    ...new Set(
      (Array.isArray(recordIds) ? recordIds : [])
        .map((recordId) => String(recordId || '').trim())
        .filter(Boolean),
    ),
  ];
  const recordIdSet = new Set(uniqueRecordIds);
  const ordered = sortCaptureTraceBindings(bindings)
    .map((binding) => binding.recordId)
    .filter((recordId) => recordIdSet.has(recordId));
  const orderedSet = new Set(ordered);
  uniqueRecordIds.forEach((recordId) => {
    if (!orderedSet.has(recordId)) {
      ordered.push(recordId);
    }
  });
  return ordered;
}

function buildCaptureTraceEventFields(recordOrTrace) {
  const candidate =
    recordOrTrace &&
    typeof recordOrTrace === 'object' &&
    ('runId' in recordOrTrace || 'identityKey' in recordOrTrace || 'sequence' in recordOrTrace)
      ? normalizeCaptureTrace(recordOrTrace)
      : resolveCaptureTraceFromRecord(recordOrTrace);
  const trace = normalizeCompleteCaptureTrace(candidate);
  return {
    captureSequence: trace?.sequence ?? null,
    captureRunId: String(trace?.runId || ''),
    captureIdentityKey: String(trace?.identityKey || ''),
  };
}

function formatCaptureTraceMarker(fields = {}, fallbackSequence = null) {
  const sequence = normalizeCaptureTraceSequence(fields.captureSequence);
  const hasCompleteTrace = Boolean(
    sequence !== null &&
      String(fields.captureRunId || '').trim() &&
      String(fields.captureIdentityKey || '').trim(),
  );
  if (hasCompleteTrace) {
    return `标记 #${sequence}`;
  }
  const itemNumber = normalizeCaptureTraceSequence(fallbackSequence);
  return itemNumber === null
    ? '未关联页面标记'
    : `第 ${itemNumber} 条（未关联页面标记）`;
}

function formatCaptureTraceProgressLabel(
  fields = {},
  current = null,
  total = null,
) {
  const sequence = normalizeCaptureTraceSequence(fields.captureSequence);
  const hasCompleteTrace = Boolean(
    sequence !== null &&
      String(fields.captureRunId || '').trim() &&
      String(fields.captureIdentityKey || '').trim(),
  );
  const currentNumber = normalizeCaptureTraceSequence(current);
  const totalNumber = normalizeCaptureTraceSequence(total);
  const position =
    currentNumber === null
      ? ''
      : totalNumber === null
        ? `第 ${currentNumber} 条`
        : `第 ${currentNumber}/${totalNumber} 条`;
  if (!hasCompleteTrace) {
    return position
      ? `${position}（未关联页面标记）`
      : '未关联页面标记';
  }
  return position ? `标记 #${sequence}（${position}）` : `标记 #${sequence}`;
}

async function reportProgressFailSoft(onProgress, payload, context = 'capture') {
  if (typeof onProgress !== 'function') {
    return false;
  }
  try {
    await Promise.resolve(onProgress(payload));
    return true;
  } catch (error) {
    console.warn(
      `[CaptureSync] ${context} progress callback failed (ignored):`,
      error?.message || error,
    );
    return false;
  }
}

function transitionRecordCaptureTrace(record, payload, state) {
  const trace = resolveCaptureTraceFromRecord({
    ...(record && typeof record === 'object' ? record : {}),
    payload,
  });
  const boundTrace = bindCaptureTrace(trace, record?.id, state);
  return {
    payload: boundTrace
      ? applyCaptureTraceToPayload(payload, boundTrace)
      : payload,
    trace: boundTrace,
    binding: buildCaptureTraceBinding(boundTrace),
  };
}

async function sendCaptureTraceBindingsToTab(tabId, bindings = []) {
  const normalizedTabId = Number(tabId);
  const normalizedBindings = sortCaptureTraceBindings(bindings).filter(
    (binding) =>
      binding.runId &&
      binding.identityKey &&
      binding.sequence !== null &&
      binding.recordId,
  );
  if (
    !Number.isFinite(normalizedTabId) ||
    normalizedTabId <= 0 ||
    normalizedBindings.length === 0
  ) {
    return false;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: normalizedTabId,
      payload: appendTaskContext(
        {
          action: 'updateListCaptureTraceBindings',
          bindings: normalizedBindings,
        },
        getActiveTaskContext(),
      ),
    });
    if (response?.ok === false) {
      console.debug(
        '[CaptureSync] capture trace binding relay ignored:',
        response?.error?.message || 'content unavailable',
      );
      return false;
    }
    return true;
  } catch (error) {
    console.debug(
      '[CaptureSync] capture trace binding relay failed (ignored):',
      error?.message || error,
    );
    return false;
  }
}

async function restoreCaptureTraceOverlayForRecords(tabId, recordIds = []) {
  const normalizedTabId = Number(tabId);
  if (
    !Number.isFinite(normalizedTabId) ||
    normalizedTabId <= 0 ||
    !Array.isArray(recordIds) ||
    recordIds.length === 0
  ) {
    return false;
  }

  const groups = new Map();
  for (const recordId of recordIds) {
    const record = await getRecord(recordId);
    const trace = normalizeCompleteCaptureTrace(
      resolveCaptureTraceFromRecord(record),
    );
    if (!record || !trace) continue;
    const payload =
      record.payload && typeof record.payload === 'object'
        ? record.payload
        : {};
    const firstItem =
      Array.isArray(payload.items) &&
      payload.items[0] &&
      typeof payload.items[0] === 'object'
        ? payload.items[0]
        : {};
    const item = {
      noteId: firstItem.noteId || payload.noteId || '',
      url: firstItem.url || payload.url || '',
      noteUrl: firstItem.noteUrl || payload.noteUrl || '',
      detailPageUrl:
        firstItem.detailPageUrl || payload.detailPageUrl || '',
      title: firstItem.title || record.title || '',
      author: firstItem.author || '',
      coverImageUrl: firstItem.coverImageUrl || '',
      domCaptureKey: firstItem.domCaptureKey || '',
      domLocator: firstItem.domLocator || null,
      domMatchHints: firstItem.domMatchHints || null,
      captureTrace: trace,
    };
    const group = groups.get(trace.runId) || [];
    group.push(item);
    groups.set(trace.runId, group);
  }

  const selected = [...groups.entries()].sort(
    (left, right) => right[1].length - left[1].length,
  )[0];
  if (!selected) return false;
  const [runId, items] = selected;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: normalizedTabId,
      payload: appendTaskContext(
        {
          action: 'restoreListCaptureTraceOverlay',
          runId,
          platform: detectPlatformFromUrl(
            String((await chrome.tabs.get(normalizedTabId))?.url || ''),
          ),
          label: '采集结果',
          items,
        },
        getActiveTaskContext(),
      ),
    });
    return response?.ok !== false;
  } catch (error) {
    console.debug(
      '[CaptureSync] restore capture trace overlay failed (ignored):',
      error?.message || error,
    );
    return false;
  }
}

async function requestCaptureCancelInTabFailSoft(tabId, reason = '') {
  const normalizedTabId = Number(tabId);
  if (!Number.isSafeInteger(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: normalizedTabId,
      payload: appendTaskContext(
        {
          action: 'cancelCapture',
          reason: String(reason || '').trim().slice(0, 120),
        },
        getActiveTaskContext(),
      ),
    });
    return response?.ok !== false;
  } catch (error) {
    console.warn(
      '[CaptureSync] cancel active detail worker failed (ignored):',
      error?.message || error,
    );
    return false;
  }
}

async function persistAndPublishCaptureTraceState({
  recordId,
  state,
  record = null,
  tabId = null,
} = {}) {
  try {
    const latestRecord = record || (recordId ? await getRecord(recordId) : null);
    const trace = bindCaptureTrace(
      resolveCaptureTraceFromRecord(latestRecord),
      recordId || latestRecord?.id,
      state,
    );
    const binding = buildCaptureTraceBinding(trace);
    if (!latestRecord || !trace || !binding) {
      return null;
    }
    const nextPayload = applyCaptureTraceToPayload(latestRecord.payload, trace);
    await updateRecord(latestRecord.id, {payload: nextPayload});
    await sendCaptureTraceBindingsToTab(tabId, [binding]);
    return trace;
  } catch (error) {
    console.debug(
      '[CaptureSync] capture trace state update failed (ignored):',
      error?.message || error,
    );
    return null;
  }
}

// ==================== M4-03: 前端接入 sync 调用 ====================
function createListCaptureCheckpointSession({mode = '', source = ''} = {}) {
  if (!isListCaptureRecordType(mode)) {
    return null;
  }

  return {
    id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mode: String(mode || '').trim(),
    source: String(source || '').trim(),
    startedAt: Date.now(),
    queue: Promise.resolve(),
    knownKeys: new Set(),
    recordIdByKey: new Map(),
    recordIds: [],
    savedRecordIds: [],
    skippedRecordIds: [],
    traceBindings: [],
    savedRecords: [],
    stats: {
      savedCount: 0,
      skippedCount: 0,
      checkpointCount: 0,
      detectedCount: 0,
      filteredCount: 0,
      lastSavedCount: 0,
      lastSkippedCount: 0,
    },
  };
}

function beginListCaptureCheckpointSession(options = {}) {
  const session = createListCaptureCheckpointSession(options);
  if (session) {
    activeListCaptureCheckpointSession = session;
  }
  return session;
}

function finishListCaptureCheckpointSession(session) {
  if (session && activeListCaptureCheckpointSession?.id === session.id) {
    activeListCaptureCheckpointSession = null;
  }
}

function collectListCaptureSessionRecordIds(session) {
  if (!session) return [];
  return orderRecordIdsByCaptureTrace(
    [
      ...(session.recordIds || []),
      ...(session.savedRecordIds || []),
      ...(session.skippedRecordIds || []),
    ],
    session.traceBindings,
  );
}

export function getActiveListCaptureCheckpointStats() {
  const session = activeListCaptureCheckpointSession;
  if (!session) return null;
  return {
    ...session.stats,
    savedRecordIds: [...session.savedRecordIds],
    skippedRecordIds: [...session.skippedRecordIds],
    traceBindings: sortCaptureTraceBindings(session.traceBindings),
  };
}

function normalizeIdentityUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) {
    raw = `https:${raw}`;
  }
  if (raw.startsWith('/')) {
    return raw.replace(/#.*$/, '').replace(/\/$/, '');
  }
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    const removableParams = [
      'xsec_token',
      'xsec_source',
      'source',
      'share_from_user_hidden',
      'type',
      'appuid',
      'apptime',
      'timestamp',
    ];
    removableParams.forEach((param) => parsed.searchParams.delete(param));
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function resolveRecordIdentityPlatform(record = {}) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
  const candidates = [
    record.platform,
    payload.platform,
    firstItem.platform,
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
    payload.searchUrl,
    payload.bloggerUrl,
  ];

  for (const candidate of candidates) {
    const direct = String(candidate || '').trim().toLowerCase();
    if (direct === 'xiaohongshu' || direct === 'douyin') {
      return direct;
    }
    const inferred = detectPlatformFromUrl(String(candidate || ''));
    if (inferred === 'xiaohongshu' || inferred === 'douyin') {
      return inferred;
    }
  }

  return 'unknown';
}

function resolveRecordIdentityKeys(record = {}) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
  const platform = resolveRecordIdentityPlatform(record);
  const noteIdCandidates = [
    firstItem.noteId,
    firstItem.id,
    payload.noteId,
    extractNoteId(firstItem.url),
    extractNoteId(firstItem.noteUrl),
    extractNoteId(firstItem.detailPageUrl),
    extractNoteId(payload.url),
    extractNoteId(payload.noteUrl),
    extractNoteId(payload.detailPageUrl),
    extractNoteId(payload.detailCaptureNoteUrl),
  ];
  const urlCandidates = [
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
    payload.detailCaptureNoteUrl,
  ];
  const keys = [];

  for (const noteId of noteIdCandidates) {
    const normalized = String(noteId || '').trim();
    if (normalized) {
      keys.push(`${platform}:note:${normalized}`);
      break;
    }
  }

  for (const url of urlCandidates) {
    const normalizedUrl = normalizeIdentityUrl(url);
    if (normalizedUrl) {
      keys.push(`${platform}:url:${normalizedUrl}`);
      break;
    }
  }

  return [...new Set(keys)];
}

function buildDataPoolIdentityIndex(records = []) {
  const keyToRecord = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    if (!isListCaptureRecordType(record?.type || record?.recordType)) return;
    resolveRecordIdentityKeys(record).forEach((key) => {
      if (key && !keyToRecord.has(key)) {
        keyToRecord.set(key, record);
      }
    });
  });
  return keyToRecord;
}

function pushUnique(target, values = []) {
  const seen = new Set(target);
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    target.push(normalized);
  });
}

function createListCaptureCacheStats(session, extra = {}) {
  const safeSession = session || activeListCaptureCheckpointSession;
  const stats = safeSession?.stats || {};
  return {
    savedCount: Number(stats.savedCount || 0),
    skippedCount: Number(stats.skippedCount || 0),
    checkpointCount: Number(stats.checkpointCount || 0),
    detectedCount: Number(stats.detectedCount || 0),
    filteredCount: Number(stats.filteredCount || 0),
    lastSavedCount: Number(stats.lastSavedCount || 0),
    lastSkippedCount: Number(stats.lastSkippedCount || 0),
    savedRecordIds: safeSession ? [...safeSession.savedRecordIds] : [],
    skippedRecordIds: safeSession ? [...safeSession.skippedRecordIds] : [],
    traceBindings: safeSession
      ? sortCaptureTraceBindings(safeSession.traceBindings)
      : [],
    ...extra,
  };
}

// StarVoice 自有逻辑（后续升级时务必保留）：列表去重命中「已存记录」时，把这次采到的【易变互动数】
// (点赞/评论/收藏/转发)就地刷新进已存记录 —— 否则同一帖第二次起永远停在首采的旧/空值,
// 监控命中的互动数永远不更新(codex/gemini review #6,实测确诊)。
// 只动这 4 个数值字段,绝不动 title/cover/detailPayload/号/评论。只要本次列表明确带了指标,
// 就允许覆盖(包括 0 和下降),这样删除评论/取消点赞也能反映到基础数据。
function refreshListCaptureMetricsInPlace(existingRecord, freshRecord) {
  const existingItem = existingRecord?.payload?.items?.[0];
  const freshItem = freshRecord?.payload?.items?.[0];
  if (!existingItem || typeof existingItem !== 'object') return false;
  if (!freshItem || typeof freshItem !== 'object') return false;
  let changed = false;
  for (const field of ['likes', 'comments', 'collects', 'shares']) {
    if (!isListMetricExplicitlyKnown(freshItem, field)) continue;
    const next = parseInteractionCount(freshItem[field]);
    const previous = parseInteractionCount(existingItem[field]);
    if (previous === next) continue; // 没变化,不动
    if (
      field === 'comments' &&
      String(existingRecord?.payload?.detailCaptureStatus || '') === DETAIL_CAPTURE_STATUS.DONE &&
      normalizeOptionalCount(existingRecord?.payload?.detailCommentCountBaseline) === null
    ) {
      existingRecord.payload.detailCommentCountBaseline = previous;
    }
    existingItem[field] = next;
    changed = true;
  }
  return changed;
}

const LIST_METRIC_KNOWN_FLAG_KEYS = Object.freeze({
  likes: ['likesKnown', 'likeCountKnown'],
  comments: [
    'commentsKnown',
    'commentsCountKnown',
    'commentCountKnown',
  ],
  collects: ['collectsKnown', 'collectsCountKnown', 'collectCountKnown'],
  shares: ['sharesKnown', 'sharesCountKnown', 'shareCountKnown'],
});

function normalizeListMetricDimension(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'comment' || normalized === 'comment_count') return 'comments';
  if (normalized === 'collect' || normalized === 'favorite') return 'collects';
  if (normalized === 'like' || normalized === 'digg') return 'likes';
  if (normalized === 'share' || normalized === 'repost') return 'shares';
  return normalized;
}

export function isListMetricExplicitlyKnown(item = {}, field = '') {
  const normalizedField = normalizeListMetricDimension(field);
  if (!hasMetricValue(item, normalizedField)) return false;

  const count = parseInteractionCount(item[normalizedField]);
  if (count > 0) return true;

  if (item?.metricKnown?.[normalizedField] === true) return true;
  const knownFlagKeys = LIST_METRIC_KNOWN_FLAG_KEYS[normalizedField] || [];
  if (knownFlagKeys.some((key) => item?.[key] === true)) return true;

  return (
    item?.displayMetricKnown === true &&
    normalizeListMetricDimension(item?.displayMetricDimension) ===
    normalizedField
  );
}

function hasMetricValue(item = {}, field) {
  if (!item || typeof item !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(item, field)) return false;
  const value = item[field];
  return value !== undefined && value !== null && value !== '';
}

function collectKeywordMatchLabels(record = {}) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const firstItem = Array.isArray(payload.items) ? payload.items[0] || {} : {};
  const candidates = [
    payload.keyword,
    payload.searchKeyword,
    payload.matchedKeyword,
    payload.matchedKeywords,
    payload.keywords,
    firstItem.keyword,
    firstItem.searchKeyword,
    firstItem.matchedKeyword,
    firstItem.matchedKeywords,
  ];
  const labels = [];
  const seen = new Set();
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    const label = String(value || '').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) {
      return;
    }
    seen.add(key);
    labels.push(label);
  };
  candidates.forEach(append);
  return labels;
}

function mergeKeywordMatchLabelsInPlace(existingRecord, freshRecord) {
  const recordType = String(existingRecord?.type || existingRecord?.recordType || '').trim();
  if (recordType !== SYNC_TYPE.KEYWORD_NOTES) {
    return false;
  }
  const existingPayload =
    existingRecord?.payload && typeof existingRecord.payload === 'object'
      ? existingRecord.payload
      : null;
  if (!existingPayload) {
    return false;
  }

  const byKey = new Map();
  collectKeywordMatchLabels(existingRecord).forEach((label) => {
    byKey.set(label.toLowerCase(), label);
  });
  const beforeSize = byKey.size;
  collectKeywordMatchLabels(freshRecord).forEach((label) => {
    const key = label.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, label);
    }
  });
  if (byKey.size === beforeSize) {
    return false;
  }

  const matchedKeywords = Array.from(byKey.values());
  existingPayload.matchedKeywords = matchedKeywords;
  const existingItem = Array.isArray(existingPayload.items)
    ? existingPayload.items[0]
    : null;
  if (existingItem && typeof existingItem === 'object') {
    existingItem.matchedKeywords = matchedKeywords;
  }
  return true;
}

function mergeCaptureTraceIntoExistingRecord(existingRecord, freshRecord) {
  const freshTrace = resolveCaptureTraceFromRecord(freshRecord);
  if (!existingRecord || !freshTrace) {
    return {changed: false, binding: null};
  }

  const currentTrace = resolveCaptureTraceFromRecord(existingRecord);
  let nextTrace = bindCaptureTrace(freshTrace, existingRecord.id, 'saved');
  if (
    currentTrace &&
    currentTrace.runId === nextTrace?.runId &&
    currentTrace.identityKey === nextTrace?.identityKey &&
    currentTrace.sequence !== null &&
    nextTrace?.sequence !== null &&
    currentTrace.sequence < nextTrace.sequence
  ) {
    nextTrace = {...nextTrace, sequence: currentTrace.sequence};
  }
  if (!nextTrace) {
    return {changed: false, binding: null};
  }

  const currentComparable = currentTrace
    ? JSON.stringify(bindCaptureTrace(currentTrace, existingRecord.id, currentTrace.state))
    : '';
  const nextComparable = JSON.stringify(nextTrace);
  if (currentComparable === nextComparable) {
    return {
      changed: false,
      binding: buildCaptureTraceBinding(nextTrace),
    };
  }

  const updatedRecord = applyCaptureTraceToRecord(existingRecord, nextTrace);
  Object.assign(existingRecord, updatedRecord, {updatedAt: Date.now()});
  return {
    changed: true,
    binding: buildCaptureTraceBinding(nextTrace),
  };
}

function uniqueRecordsById(records = []) {
  const byId = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    const recordId = String(record?.id || '').trim();
    if (!recordId || byId.has(recordId)) return;
    byId.set(recordId, record);
  });
  return [...byId.values()];
}

async function saveRecordsWithCacheDedupe(records = [], {session = null} = {}) {
  const normalizedRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  if (normalizedRecords.length === 0) {
    return {
      savedRecords: [],
      skippedCount: 0,
      skippedRecordIds: [],
      recordIds: [],
      syncRecordIds: [],
      traceBindings: [],
    };
  }

  return await runDataPoolMutation(async () => {
    const dataPool = await getDataPool();
    const existingRecords = Array.isArray(dataPool.records) ? dataPool.records : [];
    const keyToRecord = buildDataPoolIdentityIndex(existingRecords);
    const savedRecords = []; // 全新记录:入本地池(unshift)+ 同步
    const refreshedRecords = []; // 已存但刷新了互动数:就地改 + 同步,但不 unshift(避免本地重复)
    const skippedRecordIds = [];
    const traceBindings = [];
    let skippedCount = 0;

    for (const record of normalizedRecords) {
      const recordType = record?.type || record?.recordType;
      if (!isListCaptureRecordType(recordType)) {
        const boundTrace = bindCaptureTrace(
          resolveCaptureTraceFromRecord(record),
          record?.id,
          'saved',
        );
        const recordToSave = boundTrace
          ? applyCaptureTraceToRecord(record, boundTrace)
          : record;
        savedRecords.push(recordToSave);
        const binding = buildCaptureTraceBinding(boundTrace);
        if (binding) traceBindings.push(binding);
        continue;
      }

      const keys = resolveRecordIdentityKeys(record);
      const knownInSession = keys.some((key) => session?.knownKeys?.has(key));
      if (knownInSession) {
        continue;
      }

      const existingRecord = keys
        .map((key) => keyToRecord.get(key))
        .find(Boolean);
      if (existingRecord) {
        skippedCount += 1;
        const existingId = String(existingRecord.id || '').trim();
        keys.forEach((key) => session?.knownKeys?.add(key));
        const traceMerge = mergeCaptureTraceIntoExistingRecord(
          existingRecord,
          record,
        );
        if (traceMerge.binding) traceBindings.push(traceMerge.binding);
        // 不再整条丢弃:把这次采到的互动数就地刷新进已存记录并纳入同步;
        // 没刷新到(0/空/没变)才按「已采过」计入 skipped。
        const keywordLabelsChanged =
          mergeKeywordMatchLabelsInPlace(existingRecord, record);
        if (
          refreshListCaptureMetricsInPlace(existingRecord, record) ||
          keywordLabelsChanged ||
          traceMerge.changed
        ) {
          refreshedRecords.push(existingRecord);
        } else if (existingId) {
          skippedRecordIds.push(existingId);
        }
        continue;
      }

      const boundTrace = bindCaptureTrace(
        resolveCaptureTraceFromRecord(record),
        record?.id,
        'saved',
      );
      const recordToSave = boundTrace
        ? applyCaptureTraceToRecord(record, boundTrace)
        : record;
      savedRecords.push(recordToSave);
      const binding = buildCaptureTraceBinding(boundTrace);
      if (binding) traceBindings.push(binding);
      keys.forEach((key) => {
        session?.knownKeys?.add(key);
        keyToRecord.set(key, recordToSave);
      });
    }

    if (savedRecords.length > 0) {
      dataPool.records.unshift(...savedRecords); // 只 unshift 全新记录
    }
    if (savedRecords.length > 0 || refreshedRecords.length > 0) {
      // 刷新的记录是 dataPool.records 内的引用、已就地改 → 一并持久化
      await setDataPool(dataPool);
    }

    // 全新 + 已存刷新的,都回传给调用方同步(后端按新互动数 upsert)
    const syncRecords = [...savedRecords, ...refreshedRecords];
    const savedRecordIds = syncRecords.map((record) => record?.id).filter(Boolean);
    if (session) {
      session.stats.savedCount += savedRecords.length; // 统计「新增」只算全新,刷新不计新增
      session.stats.skippedCount += skippedCount;
      session.stats.lastSavedCount = savedRecords.length;
      session.stats.lastSkippedCount = skippedCount;
      session.savedRecords.push(...syncRecords);
      pushUnique(session.savedRecordIds, savedRecordIds);
      pushUnique(session.skippedRecordIds, skippedRecordIds);
      upsertCaptureTraceBindings(session.traceBindings, traceBindings);
    }

    const normalizedTraceBindings = sortCaptureTraceBindings(traceBindings);
    return {
      savedRecords: syncRecords,
      skippedCount,
      skippedRecordIds: [...new Set(skippedRecordIds)],
      recordIds: [...new Set([...savedRecordIds, ...skippedRecordIds])],
      syncRecordIds: [...new Set(savedRecordIds)],
      traceBindings: normalizedTraceBindings,
    };
  });
}

async function saveCaptureResultRecords(captureResult, {session = null} = {}) {
  const recordsToSave = buildRecordsForStorage(captureResult);
  if (!isListCaptureRecordType(captureResult?.type)) {
    if (recordsToSave.length === 0) {
      return {
        savedRecords: [],
        recordIds: [],
        syncRecordIds: [],
        traceBindings: [],
        cacheStats: null,
      };
    }
    const savedRecords =
      recordsToSave.length === 1
        ? [await addRecord(recordsToSave[0])]
        : await addRecords(recordsToSave);
    const traceBindings = sortCaptureTraceBindings(
      savedRecords
        .map((record) => buildCaptureTraceBinding(resolveCaptureTraceFromRecord(record)))
        .filter(Boolean),
    );
    const recordIds = orderRecordIdsByCaptureTrace(
      savedRecords.map((record) => record?.id).filter(Boolean),
      traceBindings,
    );
    return {
      savedRecords,
      recordIds,
      syncRecordIds: recordIds,
      traceBindings,
      cacheStats: null,
    };
  }

  if (session?.queue) {
    await session.queue.catch(() => null);
  }
  const finalSave = await saveRecordsWithCacheDedupe(recordsToSave, {session});
  const finalTraceBindings = Array.isArray(finalSave?.traceBindings)
    ? finalSave.traceBindings
    : [];
  const finalRecordIds = Array.isArray(finalSave?.recordIds)
    ? finalSave.recordIds
    : [];
  const finalSavedRecords = Array.isArray(finalSave?.savedRecords)
    ? finalSave.savedRecords
    : [];
  const traceBindings = sortCaptureTraceBindings([
    ...(session?.traceBindings || []),
    ...finalTraceBindings,
  ]);
  const recordIds = orderRecordIdsByCaptureTrace(
    [
      ...collectListCaptureSessionRecordIds(session),
      ...finalRecordIds,
    ],
    traceBindings,
  );
  const savedRecords = uniqueRecordsById([
    ...(session?.savedRecords || []),
    ...finalSavedRecords,
  ]);
  const syncRecordIds = orderRecordIdsByCaptureTrace(
    savedRecords.map((record) => record?.id),
    traceBindings,
  );

  return {
    savedRecords,
    recordIds,
    syncRecordIds,
    traceBindings,
    cacheStats: createListCaptureCacheStats(session, {
      finalSkippedCount: Number(finalSave?.skippedCount || 0),
      finalSavedCount: finalSavedRecords.length,
    }),
  };
}

export async function processListCaptureCheckpointProgress(progress = {}) {
  const session = activeListCaptureCheckpointSession;
  const checkpoint =
    progress?.listCheckpoint && typeof progress.listCheckpoint === 'object'
      ? progress.listCheckpoint
      : null;
  if (!session || !checkpoint || !isListCaptureRecordType(checkpoint.type)) {
    return null;
  }

  const checkpointItems = Array.isArray(checkpoint.items)
    ? checkpoint.items
    : Array.isArray(checkpoint.payload?.items)
      ? checkpoint.payload.items
      : [];
  if (checkpointItems.length === 0) {
    return createListCaptureCacheStats(session);
  }

  const payloadBase =
    checkpoint.payload && typeof checkpoint.payload === 'object'
      ? checkpoint.payload
      : {};
  const payload = {
    ...payloadBase,
    totalCount: checkpointItems.length,
    filteredCount: checkpointItems.length,
    items: checkpointItems,
    captureTimestamp: payloadBase.captureTimestamp || Date.now(),
  };
  const captureResult = {
    ok: true,
    type: checkpoint.type,
    platform: checkpoint.platform || payload.platform || '',
    data: payload,
    meta:
      checkpoint.meta && typeof checkpoint.meta === 'object'
        ? checkpoint.meta
        : {},
  };
  const recordsToSave = buildRecordsForStorage(captureResult);
  session.stats.checkpointCount += checkpointItems.length;
  session.stats.detectedCount = Math.max(
    session.stats.detectedCount,
    Number(progress.detectedCount || payload.rawTotalCount || 0) || 0,
  );
  session.stats.filteredCount = Math.max(
    session.stats.filteredCount,
    Number(progress.filteredCount || payload.filteredCount || 0) || 0,
  );

  session.queue = session.queue
    .catch(() => null)
    .then(() => saveRecordsWithCacheDedupe(recordsToSave, {session}))
    .catch((error) => {
      console.warn('[CaptureSync] list checkpoint save failed:', error);
      return null;
    });

  await session.queue;
  return createListCaptureCacheStats(session);
}

function isCommentLeadsEligibleSyncType(syncType) {
  return COMMENT_LEADS_ELIGIBLE_SYNC_TYPES.has(syncType);
}

function hasCommentLeadsEligibleType(syncTypes = []) {
  return Array.isArray(syncTypes)
    ? syncTypes.some((syncType) => isCommentLeadsEligibleSyncType(syncType))
    : false;
}

function truncateFrontendSyncText(value, limit = FRONTEND_SYNC_ERROR_MESSAGE_LIMIT) {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}...`;
}

function normalizeFrontendSyncError(error, {
  phase = 'sync',
  source = 'plugin_frontend',
  fallbackMessage = '前端同步失败',
} = {}) {
  const safeError = error && typeof error === 'object' ? error : {};
  const nestedError =
    safeError.error && typeof safeError.error === 'object' ? safeError.error : {};
  const reason = String(
    safeError.code ||
      safeError.reason ||
      nestedError.code ||
      nestedError.reason ||
      FRONTEND_SYNC_FAILURE_REASON,
  ).trim() || FRONTEND_SYNC_FAILURE_REASON;
  const message = truncateFrontendSyncText(
    safeError.message ||
      nestedError.message ||
      (typeof error === 'string' ? error : '') ||
      fallbackMessage,
  );
  const stack = truncateFrontendSyncText(
    String(safeError.stack || nestedError.stack || '')
      .split('\n')
      .slice(0, FRONTEND_SYNC_ERROR_STACK_LINE_LIMIT)
      .join('\n'),
    1600,
  );

  return {
    source,
    phase,
    reason,
    code: reason,
    message,
    name: String(safeError.name || nestedError.name || '').trim(),
    stack,
  };
}

function resolveFrontendFailurePlatform(syncInputs = []) {
  const platforms = new Set(
    syncInputs
      .map((input) => String(input?.platform || '').trim())
      .filter(Boolean),
  );
  if (platforms.size === 1) {
    return Array.from(platforms)[0];
  }
  if (platforms.size > 1) {
    return 'mixed';
  }
  return 'unknown';
}

function resolveFrontendFailureSyncType(syncInputs = [], requiredSyncTypes = []) {
  const syncTypes = new Set(
    syncInputs
      .map((input) => String(input?.syncType || '').trim())
      .filter(Boolean),
  );
  if (syncTypes.size === 0 && Array.isArray(requiredSyncTypes)) {
    requiredSyncTypes
      .map((syncType) => String(syncType || '').trim())
      .filter(Boolean)
      .forEach((syncType) => syncTypes.add(syncType));
  }
  if (syncTypes.size === 1) {
    return Array.from(syncTypes)[0];
  }
  if (syncTypes.size > 1) {
    return 'mixed';
  }
  return '';
}

function buildFrontendFailureItems({
  records = [],
  recordIds = [],
  requestTarget = {},
  frontendError,
} = {}) {
  const items = [];
  const seenRecordIds = new Set();
  const limitedRecords = Array.isArray(records)
    ? records.slice(0, FRONTEND_SYNC_HISTORY_ITEM_LIMIT)
    : [];

  for (const record of limitedRecords) {
    const syncInput = resolveSyncInputForRecord(record, requestTarget);
    const recordId = String(record?.id || '').trim();
    if (recordId) {
      seenRecordIds.add(recordId);
    }
    items.push({
      recordId,
      platform: syncInput.platform || 'unknown',
      type: syncInput.syncType || record?.type || '',
      sourceType: record?.type || record?.recordType || '',
      workflow: syncInput.workflow || 'shared_unknown',
      noteType: syncInput.syncType === SYNC_TYPE.SINGLE_NOTE
        ? getSingleNoteType(syncInput.payload || record?.payload)
        : null,
      success: false,
      reason: frontendError.reason,
      message: frontendError.message,
      debugUrl: null,
      rawResponse: null,
      frontendError,
      error: {
        source: frontendError.source,
        phase: frontendError.phase,
        reason: frontendError.reason,
        code: frontendError.code,
        message: frontendError.message,
        stack: frontendError.stack,
      },
    });
  }

  if (items.length > 0) {
    return items;
  }

  const limitedRecordIds = Array.isArray(recordIds)
    ? recordIds.slice(0, FRONTEND_SYNC_HISTORY_ITEM_LIMIT)
    : [];
  for (const recordId of limitedRecordIds) {
    const normalizedRecordId = String(recordId || '').trim();
    if (!normalizedRecordId || seenRecordIds.has(normalizedRecordId)) {
      continue;
    }
    items.push({
      recordId: normalizedRecordId,
      platform: 'unknown',
      type: '',
      workflow: 'frontend_failure',
      success: false,
      reason: frontendError.reason,
      message: frontendError.message,
      debugUrl: null,
      rawResponse: null,
      frontendError,
      error: {
        source: frontendError.source,
        phase: frontendError.phase,
        reason: frontendError.reason,
        code: frontendError.code,
        message: frontendError.message,
        stack: frontendError.stack,
      },
    });
  }

  return items;
}

export async function appendFrontendSyncFailureHistory({
  records = [],
  recordIds = [],
  requiredSyncTypes = [],
  error,
  phase = 'sync',
  source = 'plugin_frontend',
  trigger = 'manual',
  syncScope = 'pending',
  startedAt = Date.now(),
  fallbackMessage = '前端同步失败',
} = {}) {
  try {
    const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
    const safeRecordIds = Array.isArray(recordIds)
      ? recordIds.map((recordId) => String(recordId || '').trim()).filter(Boolean)
      : safeRecords.map((record) => String(record?.id || '').trim()).filter(Boolean);
    const target = await getTarget();
    const requestTarget = buildSyncTargetPayload(target);
    const syncInputs = safeRecords.map((record) =>
      resolveSyncInputForRecord(record, requestTarget),
    );
    const frontendError = normalizeFrontendSyncError(error, {
      phase,
      source,
      fallbackMessage,
    });
    const platform = resolveFrontendFailurePlatform(syncInputs);
    const syncType = resolveFrontendFailureSyncType(syncInputs, requiredSyncTypes);
    const workflow =
      syncInputs.length === 1
        ? syncInputs[0]?.workflow || 'frontend_failure'
        : 'frontend_failure';
    const items = buildFrontendFailureItems({
      records: safeRecords,
      recordIds: safeRecordIds,
      requestTarget,
      frontendError,
    });
    const failedCount = Math.max(
      items.length,
      safeRecordIds.length,
      safeRecords.length,
      1,
    );

    return await addSyncHistoryEntry({
      trigger,
      syncScope,
      startedAt,
      finishedAt: Date.now(),
      totalCount: failedCount,
      requestedTotalCount: Math.max(safeRecordIds.length, safeRecords.length, failedCount),
      skippedCount: 0,
      successCount: 0,
      failedCount,
      debugUrl: null,
      platform,
      syncType,
      workflow,
      target: buildSyncHistoryTarget(requestTarget, {
        platform,
        syncType,
        workflow,
      }),
      recordIds: safeRecordIds,
      skippedRecordIds: [],
      frontendFailure: true,
      frontendError,
      errorMessage: frontendError.message,
      message: frontendError.message,
      items,
    });
  } catch (historyError) {
    console.error('[CaptureSync] Append frontend sync failure history failed:', historyError);
    return null;
  }
}

// ==================== M4-03: 前端接入 sync 调用 ====================

/**
 * 采集并同步（完整流程）
 * @param {Object} options - 配置选项
 * @param {string} options.mode - 采集模式
 * @param {Function} options.onProgress - 进度回调
 * @param {boolean} options.autoSync - 是否自动同步（默认 true）
 * @param {Object} options.captureParams - 采集参数透传
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSync({
  mode = 'auto',
  onProgress = null,
  autoSync = true,
  captureParams = {},
  shouldStop = null,
  signal = null,
} = {}) {
  let savedRecords = [];
  let recordIds = [];
  let syncRecordIds = [];
  let traceBindings = [];
  let recordId = null;
  let sourceCaptureTabId = null;
  let syncStartedAt = Date.now();
  let captureCacheStats = null;
  const checkpointSession = beginListCaptureCheckpointSession({
    mode,
    source: 'captureAndSync',
  });

  try {
    // 步骤 1: 开始采集
    if (onProgress) {
      onProgress({
        phase: 'capture_start',
        message: '开始采集数据...',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.CAPTURING,
      error: null,
    });

    // 步骤 2: 执行采集
    const captureResult = await captureInActiveTab({
      mode,
      onProgress,
      captureParams,
      onTargetTab: (tab) => {
        const resolvedTabId = Number(tab?.id);
        if (Number.isFinite(resolvedTabId) && resolvedTabId > 0) {
          sourceCaptureTabId = resolvedTabId;
        }
      },
    });

    // 步骤 3: 检查采集是否成功
    if (!captureResult.ok) {
      if (checkpointSession?.queue) {
        await checkpointSession.queue.catch(() => null);
      }
      captureCacheStats = createListCaptureCacheStats(checkpointSession);
      traceBindings = sortCaptureTraceBindings(
        checkpointSession?.traceBindings || [],
      );
      await sendCaptureTraceBindingsToTab(sourceCaptureTabId, traceBindings);
      finishListCaptureCheckpointSession(checkpointSession);
      await updateCapture({
        status: CAPTURE_STATUS.FAILED,
        error: captureResult.error,
      });

      return {
        ok: false,
        phase: 'capture',
        captureResult,
        syncResult: null,
        recordId: null,
        recordIds: collectListCaptureSessionRecordIds(checkpointSession),
        traceBindings,
        captureCacheStats,
        error: captureResult.error,
      };
    }

    // 步骤 4: 采集成功，将结果入池
    if (onProgress) {
      onProgress({
        phase: 'saving',
        message: '保存到本地数据池...',
      });
    }

    const saveResult = await saveCaptureResultRecords(captureResult, {
      session: checkpointSession,
    });
    finishListCaptureCheckpointSession(checkpointSession);
    savedRecords = saveResult.savedRecords || [];
    recordIds = Array.isArray(saveResult.recordIds) ? saveResult.recordIds : [];
    syncRecordIds = Array.isArray(saveResult.syncRecordIds)
      ? saveResult.syncRecordIds
      : [];
    traceBindings = Array.isArray(saveResult.traceBindings)
      ? saveResult.traceBindings
      : [];
    captureCacheStats = saveResult.cacheStats || captureCacheStats;
    await sendCaptureTraceBindingsToTab(sourceCaptureTabId, traceBindings);

    if (recordIds.length > 0) {
      recordId = recordIds[0] || null;
      trackCoreCaptureSuccess(savedRecords.length, {
        mode,
        source: 'capture_and_save',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.SUCCESS,
      lastCapturedAt: new Date().toISOString(),
      error: null,
    });

    if (onProgress) {
      onProgress({
        phase: 'saved',
        message: `已保存到本地（${recordIds.length} 条）`,
        recordId,
        recordIds,
        traceBindings,
      });
    }

    // 步骤 5: 如果不自动同步，到此结束
    if (!autoSync || syncRecordIds.length === 0) {
      return {
        ok: true,
        phase: 'saved',
        captureResult,
        syncResult: null,
        recordId,
        recordIds,
        traceBindings,
        captureCacheStats,
        error: null,
      };
    }

    // 步骤 6: 执行同步前检查（M4-05）
    if (isSyncCancellationRequested(shouldStop, signal)) {
      return {
        ...buildCanceledSyncResult(),
        phase: 'canceled',
        captureResult,
        syncResult: null,
        recordId,
        recordIds,
        traceBindings,
      };
    }
    if (onProgress) {
      onProgress({
        phase: 'sync_check',
        message: '正在校验授权与同步配置...',
        recordId,
      });
    }
    const captureSettings = await getCaptureSettings();
    const commentLeadsConfig = buildCommentLeadsConfigFromSettings(captureSettings);
    const requiredSyncTypes = savedRecords.map((record) => record.type || record.recordType);
    if (
      commentLeadsConfig.enabled &&
      hasCommentLeadsEligibleType(requiredSyncTypes)
    ) {
      requiredSyncTypes.push(SYNC_TYPE.COMMENT_LEADS);
    }
    syncStartedAt = Date.now();
    const checkResult = await checkBeforeSync(
      requiredSyncTypes,
      { onProgress },
    );
    if (isSyncCancellationRequested(shouldStop, signal)) {
      return {
        ...buildCanceledSyncResult(),
        phase: 'canceled',
        captureResult,
        syncResult: null,
        recordId,
        recordIds,
        traceBindings,
      };
    }
    if (!checkResult.ok) {
      await appendFrontendSyncFailureHistory({
        records: savedRecords,
        recordIds: syncRecordIds,
        requiredSyncTypes,
        error: checkResult.error || checkResult,
        phase: 'sync_check',
        source: 'captureAndSync',
        trigger: 'capture_auto',
        syncScope: 'pending',
        startedAt: syncStartedAt,
        fallbackMessage: '自动同步前检查失败',
      });
      return {
        ok: false,
        phase: 'check',
        captureResult,
        syncResult: null,
        recordId,
        recordIds,
        traceBindings,
        error: checkResult.error,
      };
    }

    // 步骤 7: 执行同步
    syncStartedAt = Date.now();
    if (onProgress) {
      onProgress({
        phase: 'sync_start',
        message: '开始同步到飞书...',
        recordId,
      });
    }

    const syncResult =
      syncRecordIds.length === 1
        ? await syncRecord(syncRecordIds[0], onProgress, {
            trigger: 'capture_auto',
            commentLeadsConfig,
            shouldStop,
            signal,
          })
        : await syncRecordBatch(syncRecordIds, onProgress, {
            trigger: 'capture_auto',
            commentLeadsConfig,
            shouldStop,
            signal,
          });

    return {
      ok: syncResult.ok,
      phase: syncResult.ok ? 'synced' : 'sync_failed',
      captureResult,
      syncResult,
      recordId,
      recordIds,
      traceBindings,
      captureCacheStats,
      error: syncResult.error || null,
    };
  } catch (error) {
    console.error('[CaptureSync] Capture and sync failed:', error);
    if (checkpointSession?.queue) {
      await checkpointSession.queue.catch(() => null);
    }
    captureCacheStats = captureCacheStats || createListCaptureCacheStats(checkpointSession);
    finishListCaptureCheckpointSession(checkpointSession);

    if (autoSync && syncRecordIds.length > 0) {
      await appendFrontendSyncFailureHistory({
        records: savedRecords,
        recordIds: syncRecordIds,
        error,
        phase: 'sync_exception',
        source: 'captureAndSync',
        trigger: 'capture_auto',
        syncScope: 'pending',
        startedAt: syncStartedAt,
        fallbackMessage: '自动同步失败',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.FAILED,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    });

    return {
      ok: false,
      phase: 'error',
      captureResult: null,
      syncResult: null,
      recordId: null,
      recordIds: collectListCaptureSessionRecordIds(checkpointSession),
      traceBindings:
        traceBindings.length > 0
          ? traceBindings
          : sortCaptureTraceBindings(checkpointSession?.traceBindings || []),
      captureCacheStats,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

async function captureAndSaveInTab({
  tabId,
  mode = 'auto',
  captureParams = {},
  onProgress = null,
  checkpointSource = 'captureAndSaveInTab',
} = {}) {
  let savedRecords = [];
  let captureCacheStats = null;
  let traceBindings = [];
  const checkpointSession = beginListCaptureCheckpointSession({
    mode,
    source: checkpointSource,
  });

  try {
    if (onProgress) {
      onProgress({
        phase: 'capture_start',
        message: '开始采集数据...',
      });
    }
    await updateCapture({
      status: CAPTURE_STATUS.CAPTURING,
      error: null,
    });

    const captureResult = await captureInTab(tabId, {
      mode,
      captureParams,
    });

    if (!captureResult?.ok) {
      const partialItems = Array.isArray(captureResult?.data?.items)
        ? captureResult.data.items
        : [];
      if (captureResult?.partial === true && partialItems.length > 0) {
        const partialSaveResult = await saveCaptureResultRecords(
          {
            ...captureResult,
            ok: true,
            error: null,
          },
          {session: checkpointSession},
        );
        savedRecords = Array.isArray(partialSaveResult?.savedRecords)
          ? partialSaveResult.savedRecords
          : [];
        traceBindings = Array.isArray(partialSaveResult?.traceBindings)
          ? partialSaveResult.traceBindings
          : [];
        captureCacheStats = partialSaveResult?.cacheStats || null;
      }
      if (checkpointSession?.queue) {
        await checkpointSession.queue.catch(() => null);
      }
      captureCacheStats =
        captureCacheStats || createListCaptureCacheStats(checkpointSession);
      const partialRecordIds =
        collectListCaptureSessionRecordIds(checkpointSession);
      traceBindings = sortCaptureTraceBindings([
        ...traceBindings,
        ...(checkpointSession?.traceBindings || []),
      ]);
      await sendCaptureTraceBindingsToTab(tabId, traceBindings);
      finishListCaptureCheckpointSession(checkpointSession);
      await updateCapture({
        status: CAPTURE_STATUS.FAILED,
        error: captureResult?.error || {
          code: 'CAPTURE_FAILED',
          message: '采集失败',
        },
      });

      return {
        ok: false,
        phase: 'capture',
        captureResult,
        savedRecords,
        recordIds: partialRecordIds,
        traceBindings,
        captureCacheStats,
        error: captureResult?.error || null,
      };
    }

    if (onProgress) {
      onProgress({
        phase: 'saving',
        message: '保存到本地数据池...',
      });
    }
    const saveResult = await saveCaptureResultRecords(captureResult, {
      session: checkpointSession,
    });
    finishListCaptureCheckpointSession(checkpointSession);
    savedRecords = Array.isArray(saveResult.savedRecords)
      ? saveResult.savedRecords
      : [];
    const recordIds = Array.isArray(saveResult.recordIds)
      ? saveResult.recordIds
      : [];
    traceBindings = Array.isArray(saveResult.traceBindings)
      ? saveResult.traceBindings
      : [];
    captureCacheStats = saveResult.cacheStats || null;
    await sendCaptureTraceBindingsToTab(tabId, traceBindings);

    await updateCapture({
      status: CAPTURE_STATUS.SUCCESS,
      lastCapturedAt: new Date().toISOString(),
      error: null,
    });

    if (recordIds.length > 0) {
      trackCoreCaptureSuccess(savedRecords.length, {
        mode,
        source: checkpointSource,
      });
    }
    if (onProgress) {
      onProgress({
        phase: 'saved',
        message: `已保存到本地（${recordIds.length} 条）`,
        recordIds,
        traceBindings,
      });
    }

    return {
      ok: true,
      phase: 'saved',
      captureResult,
      savedRecords,
      recordIds,
      traceBindings,
      captureCacheStats,
      error: null,
    };
  } catch (error) {
    if (checkpointSession?.queue) {
      await checkpointSession.queue.catch(() => null);
    }
    captureCacheStats =
      captureCacheStats || createListCaptureCacheStats(checkpointSession);
    const partialRecordIds = collectListCaptureSessionRecordIds(
      checkpointSession,
    );
    finishListCaptureCheckpointSession(checkpointSession);
    await updateCapture({
      status: CAPTURE_STATUS.FAILED,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    });
    return {
      ok: false,
      phase: 'error',
      captureResult: null,
      savedRecords: [],
      recordIds: partialRecordIds,
      traceBindings:
        traceBindings.length > 0
          ? traceBindings
          : sortCaptureTraceBindings(checkpointSession?.traceBindings || []),
      captureCacheStats,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 单条笔记采集（可选评论），并将评论合并回同一条 single_note 记录
 */
export async function captureNoteWithOptionalComments({
  includeComments = false,
  includeBloggerMetrics = false,
  enableCommentLeadsFilter = null,
  commentsMaxDetectedItems = null,
  commentsMaxItems = null,
  detailNavTimeoutMs = null,
  profileAfterNavWaitMs = null,
  onProgress = null,
} = {}) {
  try {
    if (onProgress) {
      onProgress({
        phase: 'note_capturing',
        message: '正在采集笔记...',
      });
    }

    await updateCapture({
      status: CAPTURE_STATUS.CAPTURING,
      error: null,
    });

    const activeTab = await getCurrentActiveTab();
    const activePlatform = detectPlatformFromUrl(String(activeTab?.url || ''));
    let useWorksTabForDouyinMetrics =
      includeBloggerMetrics &&
      activePlatform === 'douyin' &&
      isDouyinContentFlowUrl(String(activeTab?.url || ''));
    const noteResult = await captureInActiveTab({
      mode: 'single',
      captureParams: {
        includeBloggerMetrics,
        preferWorksTabForBloggerMetrics: useWorksTabForDouyinMetrics,
      },
    });

    if (!noteResult.ok) {
      await updateCapture({
        status: CAPTURE_STATUS.FAILED,
        error: noteResult.error,
      });

      return {
        ok: false,
        phase: 'note_failed',
        recordId: null,
        error: noteResult.error,
      };
    }

    if (includeBloggerMetrics && activePlatform === 'douyin') {
      const sourceUrl = String(noteResult?.meta?.sourceUrl || '').trim();
      if (sourceUrl) {
        useWorksTabForDouyinMetrics = isDouyinContentFlowUrl(sourceUrl);
      }
    }

    const notePayloadWithCommentState = applyCommentStatusToPayload(
      noteResult.data,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.NOT_STARTED,
        startedAt: 0,
        finishedAt: 0,
        stoppedByUser: false,
        error: '',
        cleanedItems: [],
      }),
    );
    const notePayloadWithEnhancementState = applyBloggerMetricsPatch(
      notePayloadWithCommentState,
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED,
        error: '',
        profileUrl: noteResult.data?.authorUrl || '',
      }),
    );

    const recordsToSave = buildRecordsForStorage({
      ...noteResult,
      data: notePayloadWithEnhancementState,
    });
    if (recordsToSave.length === 0) {
      throw new Error('笔记记录构建失败');
    }
    const saved = await addRecord(recordsToSave[0]);
    const recordId = saved?.id || null;
    trackCoreCaptureSuccess(recordId ? 1 : 0, {
      mode: 'single_note',
      source: 'single_note_with_enhancement_state',
    });

    await updateCapture({
      status: CAPTURE_STATUS.SUCCESS,
      lastCapturedAt: new Date().toISOString(),
      error: null,
    });

    if (!includeComments && !includeBloggerMetrics) {
      if (onProgress) {
        onProgress({
          phase: 'note_ready',
          message: '笔记采集完成，评论未启用',
          recordId,
        });
      }
      return {
        ok: true,
        phase: 'note_ready',
        recordId,
        commentsResult: null,
        bloggerMetricsResult: null,
        error: null,
      };
    }

    const settings = await getCaptureSettings();
    const normalizedDetailNavTimeoutMs = normalizePositiveInteger(
      detailNavTimeoutMs ?? settings.detailNavTimeoutMs,
      DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    );
    const normalizedProfileAfterNavWaitMs = normalizePositiveInteger(
      profileAfterNavWaitMs ?? settings.profileAfterNavWaitMs,
      PROFILE_AFTER_NAV_WAIT_MS,
    );

    let commentsResult = null;
    let bloggerMetricsResult = null;
    let optionalFailed = false;

    if (includeBloggerMetrics) {
      bloggerMetricsResult = await captureBloggerMetricsForSingleNoteRecord(
        recordId,
        {
          preferWorksTabForBloggerMetrics: useWorksTabForDouyinMetrics,
          detailNavTimeoutMs: normalizedDetailNavTimeoutMs,
          profileAfterNavWaitMs: normalizedProfileAfterNavWaitMs,
          onProgress,
        },
      );
      if (!bloggerMetricsResult.ok) {
        optionalFailed = true;
      }
    }

    if (includeComments) {
      commentsResult = await captureCommentsForSingleNoteRecord(recordId, {
        commentsMaxDetectedItems:
          commentsMaxDetectedItems ?? commentsMaxItems,
        enableCommentLeadsFilter,
        onProgress,
      });
      if (!commentsResult.ok) {
        optionalFailed = true;
      }
    }

    if (optionalFailed) {
      return {
        ok: false,
        noteReady: true,
        phase:
          (commentsResult && !commentsResult.ok && commentsResult.phase) ||
          (bloggerMetricsResult && !bloggerMetricsResult.ok
            ? 'blogger_metrics_failed'
            : 'partial_failed'),
        recordId,
        commentsResult,
        bloggerMetricsResult,
        error:
          commentsResult?.error ||
          bloggerMetricsResult?.error || {
            code: 'OPTIONAL_CAPTURE_FAILED',
            message: '可选增强采集失败',
          },
      };
    }

    return {
      ok: true,
      phase:
        commentsResult?.phase ||
        (includeBloggerMetrics ? 'blogger_metrics_done' : 'note_ready'),
      recordId,
      commentsResult,
      bloggerMetricsResult,
      error: null,
    };
  } catch (error) {
    console.error('[CaptureSync] captureNoteWithOptionalComments failed:', error);
    await updateCapture({
      status: CAPTURE_STATUS.FAILED,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    });
    return {
      ok: false,
      phase: 'error',
      recordId: null,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 仅重试某条记录的评论采集与合并
 */
export async function retryCommentsForRecord(
  recordId,
  {
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    onProgress = null,
  } = {},
) {
  try {
    const record = await getRecord(recordId);
    const isSingleNoteRecord = record?.type === SYNC_TYPE.SINGLE_NOTE;
    const isHydratedDetailRecord = Boolean(
      record &&
        isDetailCaptureRecordType(record.type) &&
        record.payload?.detailPayload &&
        typeof record.payload.detailPayload === 'object',
    );
    if (!record || (!isSingleNoteRecord && !isHydratedDetailRecord)) {
      return {
        ok: false,
        phase: 'invalid_record',
        recordId,
        error: {
          code: 'RECORD_NOT_FOUND',
          message: '记录不存在或没有可继续采集评论的详情数据',
        },
      };
    }

    const noteUrl = resolveRecordNoteUrl(record);
    if (!noteUrl) {
      return {
        ok: false,
        phase: 'note_url_missing',
        recordId,
        error: {
          code: 'NOTE_URL_MISSING',
          message: '未找到可访问的笔记链接',
        },
      };
    }

    const activeTab = await getCurrentActiveTab();
    const activeTabId = Number(activeTab?.id);
    if (!Number.isFinite(activeTabId) || activeTabId <= 0) {
      throw new Error('未找到当前活动标签页');
    }
    const commentCaptureIdentity = await ensureCommentCaptureIdentity({
      runnerTabId: activeTabId,
    });
    if (onProgress) {
      onProgress({
        phase: 'comments_opening',
        message: '正在打开对应笔记详情页...',
        recordId,
        noteUrl,
        captureRequestId: commentCaptureIdentity.captureRequestId,
        runnerTabId: commentCaptureIdentity.runnerTabId,
        captureAction: 'captureComments',
      });
    }

    const settings = await getCaptureSettings();
    const navTimeoutMs = normalizePositiveInteger(
      settings.detailNavTimeoutMs,
      DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    );
    const afterNavWaitMs = normalizePositiveInteger(
      settings.detailAfterNavWaitMs,
      DETAIL_CAPTURE_AFTER_NAV_WAIT_MS,
    );

    await openUrlInTab(commentCaptureIdentity.runnerTabId, noteUrl, {
      timeoutMs: navTimeoutMs,
      active: true,
    });
    await waitMs(afterNavWaitMs);

    if (isSingleNoteRecord) {
      return await captureCommentsForSingleNoteRecord(recordId, {
        commentsMaxDetectedItems:
          commentsMaxDetectedItems ?? commentsMaxItems,
        captureRequestId: commentCaptureIdentity.captureRequestId,
        runnerTabId: commentCaptureIdentity.runnerTabId,
        onProgress,
      });
    }

    return await captureCommentsForHydratedDetailRecord(recordId, {
      tabId: commentCaptureIdentity.runnerTabId,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      settings,
      commentsMaxDetectedItems:
        commentsMaxDetectedItems ?? commentsMaxItems,
      onProgress,
    });
  } catch (error) {
    console.error('[CaptureSync] retryCommentsForRecord failed:', error);
    return {
      ok: false,
      phase: 'error',
      recordId,
      error: {
        code: String(error?.code || 'UNEXPECTED_ERROR'),
        message: error.message,
      },
    };
  }
}

/**
 * 仅重试某条 blogger_notes / keyword_notes 记录的详情补采
 */
export async function retryDetailCaptureForRecord(
  recordId,
  {
    onProgress = null,
    shouldStop = null,
    detailNavTimeoutMs = null,
    detailAfterNavWaitMs = null,
    profileAfterNavWaitMs = null,
  } = {},
) {
  try {
    const record = await getRecord(recordId);
    if (!record || !isDetailCaptureRecordType(record.type)) {
      return {
        ok: false,
        canceled: false,
        total: 1,
        processedCount: 0,
        successCount: 0,
        failedCount: 0,
        results: [],
        error: {
          code: 'RECORD_NOT_FOUND',
          message: '记录不存在或类型不支持补采详情',
        },
      };
    }

    return await batchCaptureDetailsForRecords([recordId], {
      onProgress,
      shouldStop,
      includeComments: false,
      includeBloggerMetrics: false,
      detailNavTimeoutMs,
      detailAfterNavWaitMs,
      profileAfterNavWaitMs,
    });
  } catch (error) {
    console.error('[CaptureSync] retryDetailCaptureForRecord failed:', error);
    return {
      ok: false,
      canceled: false,
      total: 1,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }
}

/**
 * 从抖音作品 URL 或 noteId 中提取纯数字作品 ID,用于补采时的"防串号"比对。
 * 抖音作品 ID 是长数字串;URL 形如 /video/{id}、/note/{id} 或 ?modal_id={id}。
 * 提取不到时返回空串(调用方遇空串则不做比对,保持原行为、不误杀)。
 */
function extractDouyinDetailGuardItemId(source) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  if (/^\d{6,}$/.test(raw)) return raw;
  const modalMatch = raw.match(/[?&]modal_id=(\d{6,})/);
  if (modalMatch) return modalMatch[1];
  const pathMatch = raw.match(/\/(?:video|note)\/(\d{6,})/);
  if (pathMatch) return pathMatch[1];
  return '';
}

function resolveExpectedDouyinCommentNoteId(record, fallbackUrl = '') {
  const platform = String(
    record?.platform || detectPlatformFromUrl(String(fallbackUrl || '')),
  )
    .trim()
    .toLowerCase();
  if (platform !== 'douyin') {
    return '';
  }
  return (
    extractDouyinDetailGuardItemId(resolveRecordDetailNoteId(record)) ||
    extractDouyinDetailGuardItemId(fallbackUrl)
  );
}

function resolveCapturedDouyinCommentNoteId(result) {
  const capturedIds = new Set(
    [
      result?.noteId,
      result?.data?.noteId,
      result?.data?.noteUrl,
      result?.data?.url,
    ]
      .map(extractDouyinDetailGuardItemId)
      .filter(Boolean),
  );
  // A response carrying multiple work IDs is internally inconsistent. Never
  // pick the first one and allow a potentially wrong cloud merge.
  return capturedIds.size === 1 ? [...capturedIds][0] : '';
}

function resolveVerifiedDouyinDetailNoteId(
  detailPayload = {},
  expectedNoteId = '',
) {
  const expected = extractDouyinDetailGuardItemId(expectedNoteId);
  if (!expected || !detailPayload || typeof detailPayload !== 'object') {
    return '';
  }
  const capturedIds = new Set(
    [
      detailPayload.noteId,
      detailPayload.url,
      detailPayload.noteUrl,
    ]
      .map(extractDouyinDetailGuardItemId)
      .filter(Boolean),
  );
  return capturedIds.size === 1 && capturedIds.has(expected) ? expected : '';
}

function buildDouyinDetailIdentityError(
  expectedNoteId,
  detailPayload = {},
) {
  const expected = extractDouyinDetailGuardItemId(expectedNoteId);
  const capturedIds = [
    detailPayload?.noteId,
    detailPayload?.url,
    detailPayload?.noteUrl,
  ]
    .map(extractDouyinDetailGuardItemId)
    .filter(Boolean);
  const actualLabel =
    [...new Set(capturedIds)].join(', ') || '无法识别';
  const error = new Error(
    `抖音详情作品不匹配：目标 ${expected || '无法识别'}，实际 ${actualLabel}`,
  );
  error.code = 'DOUYIN_DETAIL_ID_MISMATCH';
  error.expectedNoteId = expected;
  error.actualNoteId = actualLabel;
  return error;
}

function isDouyinIdentityIntegrityError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  return (
    code === 'DOUYIN_DETAIL_ID_MISMATCH' ||
    code === 'DOUYIN_COMMENT_ID_MISMATCH' ||
    code === 'DOUYIN_COMMENT_ID_CONFLICT'
  );
}

function buildDouyinCommentIdentityFailure(expectedNoteId, actualNoteId) {
  const expected = extractDouyinDetailGuardItemId(expectedNoteId);
  if (!expected) {
    return null;
  }
  const actual = extractDouyinDetailGuardItemId(actualNoteId);
  if (actual === expected) {
    return null;
  }
  return {
    code: 'DOUYIN_COMMENT_ID_MISMATCH',
    message: `抖音评论作品不匹配：目标 ${expected}，实际 ${actual || '无法识别'}`,
    expectedNoteId: expected,
    actualNoteId: actual,
  };
}

function attachPartialDetailPayload(error, detailPayload) {
  const effectiveError =
    error && typeof error === 'object'
      ? error
      : new Error(String(error || '评论采集失败，请稍后重试'));
  if (effectiveError.partialDetailPayload === undefined) {
    effectiveError.partialDetailPayload = detailPayload;
  }
  return effectiveError;
}

/**
 * 批量补采博主/关键词记录的笔记详情，回填到原记录 payload
 */
export async function batchCaptureDetailsForRecords(
  recordIds,
  {
    onProgress = null,
    shouldStop = null,
    includeComments = false,
    includeBloggerMetrics = false,
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    enableLowFollowerHitFilter = null,
    lowFollowerHitThreshold = null,
    detailNavTimeoutMs = null,
    detailAfterNavWaitMs = null,
    profileAfterNavWaitMs = null,
    skipAlreadyCaptured = null,
    waitForegroundTabId = null,
    captureTaskId = '',
    relevanceKeyword = '',
    enableAiRelevancePrefilter = null,
  } = {},
) {
  const uniqueRecordIds = Array.isArray(recordIds)
    ? [...new Set(recordIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];

  if (uniqueRecordIds.length === 0) {
    return {
      ok: false,
      canceled: false,
      total: 0,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      results: [],
      error: {
        code: 'NO_RECORDS',
        message: '没有可补采的记录',
      },
    };
  }

  const buildSetupFailureResult = async ({
    code,
    message,
    sourceTabId = null,
    runnerTabId = null,
    aiFilteredRecordIds = new Set(),
    alreadyCapturedRecordIds = new Set(),
    relevanceDecisionById = new Map(),
  } = {}) => {
    const normalizedCode =
      String(code || 'RUNNER_TAB_UNAVAILABLE').trim().toUpperCase() ||
      'RUNNER_TAB_UNAVAILABLE';
    const normalizedMessage =
      String(message || '详情采集工作页初始化失败，请稍后重试').trim() ||
      '详情采集工作页初始化失败，请稍后重试';
    const results = [];
    let failedCount = 0;
    let filteredCount = 0;
    let skippedCount = 0;

    for (let index = 0; index < uniqueRecordIds.length; index += 1) {
      const recordId = uniqueRecordIds[index];
      const record = await getRecord(recordId).catch(() => null);
      const captureTraceFields = buildCaptureTraceEventFields(record);
      const markerLabel = formatCaptureTraceMarker(
        captureTraceFields,
        index + 1,
      );
      const progressLabel = formatCaptureTraceProgressLabel(
        captureTraceFields,
        index + 1,
        uniqueRecordIds.length,
      );

      if (aiFilteredRecordIds.has(recordId)) {
        const decision = relevanceDecisionById.get(recordId) || {};
        filteredCount += 1;
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'filtered',
          record,
          tabId: sourceTabId,
        });
        const item = {
          recordId,
          ok: true,
          filtered: true,
          reason: 'ai_relevance_filtered',
          message: `${markerLabel} AI 高置信度判定无关，已跳过采集增强`,
          aiRelevanceConfidence: decision.confidence ?? null,
          aiRelevanceReason: decision.reason || '',
          ...captureTraceFields,
        };
        results.push(item);
        await reportProgressFailSoft(onProgress, {
          ...item,
          phase: 'detail_item_filtered',
          message: `${progressLabel}：AI 高置信度判定无关，已跳过详情、评论和博主采集`,
          current: index + 1,
          total: uniqueRecordIds.length,
          successCount: 0,
          failedCount,
          filteredCount,
          skippedCount,
          runnerTabId,
        }, 'detail setup ai-filtered item');
        continue;
      }

      if (alreadyCapturedRecordIds.has(recordId)) {
        skippedCount += 1;
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'skipped',
          record,
          tabId: sourceTabId,
        });
        const item = {
          recordId,
          ok: true,
          skipped: true,
          reason: 'already_captured',
          message: `${markerLabel} 之前已采过，自动跳过`,
          ...captureTraceFields,
        };
        results.push(item);
        await reportProgressFailSoft(onProgress, {
          ...item,
          phase: 'detail_item_skipped',
          message: `${progressLabel}：之前已采过，跳过（增量采集）`,
          current: index + 1,
          total: uniqueRecordIds.length,
          successCount: 0,
          failedCount,
          filteredCount,
          skippedCount,
          runnerTabId,
        }, 'detail setup already-captured item');
        continue;
      }

      failedCount += 1;
      // 初始化阶段失败也必须落成一条完整的失败记录。否则调用方虽然能
      // 收到 failedCount，卡片仍会停留在“未执行/采集中”，随后又可能被
      // 同步队列当成待处理项重新入队。
      if (record) {
        try {
          const finishedAt = Date.now();
          const failedPayload = applyDetailCapturePatch(
            record.payload,
            createDetailCapturePatch({
              status: DETAIL_CAPTURE_STATUS.FAILED,
              startedAt:
                Number(record?.payload?.detailCaptureStartedAt) || finishedAt,
              finishedAt,
              error: normalizedMessage,
              failureCode: normalizedCode,
              failureStage: 'runner_initialization',
              failureCategory:
                DETAIL_CAPTURE_FAILURE_CATEGORY.CONTEXT_INTERRUPTED,
              diagnosticMessage: normalizedMessage,
              noteUrl: resolveRecordNoteUrl(record),
            }),
          );
          const failedTraceTransition = transitionRecordCaptureTrace(
            record,
            failedPayload,
            'runner_interrupted',
          );
          await updateRecord(recordId, {
            status: RECORD_STATUS.DRAFT,
            payload: failedTraceTransition.payload,
          });
          if (failedTraceTransition.binding) {
            await sendCaptureTraceBindingsToTab(sourceTabId, [
              failedTraceTransition.binding,
            ]);
          }
        } catch (error) {
          // 结果契约优先：即使本地持久化异常，也不能吞掉逐条失败结果。
          console.warn(
            '[CaptureSync] persist detail setup failure failed (ignored):',
            error?.message || error,
          );
        }
      }
      const item = {
        recordId,
        ok: false,
        reason: normalizedCode,
        code: normalizedCode,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.CONTEXT_INTERRUPTED,
        stage: 'runner_initialization',
        message: `${markerLabel}：${normalizedMessage}`,
        diagnosticMessage: normalizedMessage,
        runnerInterrupted: true,
        recoveryRequired: true,
        ...captureTraceFields,
      };
      results.push(item);
      await reportProgressFailSoft(onProgress, {
        ...item,
        phase: 'detail_item_failed',
        message: `${progressLabel}：${normalizedMessage}`,
        current: index + 1,
        total: uniqueRecordIds.length,
        successCount: 0,
        failedCount,
        filteredCount,
        skippedCount,
        runnerTabId,
        sourceTabId,
      }, 'detail setup failed item');
    }

    await reportProgressFailSoft(onProgress, {
      phase: 'detail_batch_init_failed',
      message: `${normalizedMessage}（失败 ${failedCount} 条）`,
      current: results.length,
      total: uniqueRecordIds.length,
      successCount: 0,
      failedCount,
      filteredCount,
      skippedCount,
      runnerTabId,
      sourceTabId,
      runnerInterrupted: true,
      recoveryRequired: true,
      error: {code: normalizedCode, message: normalizedMessage},
    }, 'detail batch setup failed');

    return {
      ok: false,
      canceled: false,
      runnerInterrupted: true,
      recoveryRequired: true,
      securityBlocked: false,
      total: uniqueRecordIds.length,
      processedCount: results.length,
      successCount: 0,
      failedCount,
      filteredCount,
      skippedCount,
      results,
      diagnostics: {stageTrace: []},
      error: {
        code: normalizedCode,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.CONTEXT_INTERRUPTED,
        stage: 'runner_initialization',
        message: normalizedMessage,
      },
    };
  };

  let activeTab = null;
  try {
    activeTab = await getCurrentActiveTab();
  } catch (error) {
    return await buildSetupFailureResult({
      code: 'TAB_NOT_FOUND',
      message: error.message || '未找到当前活动标签页',
    });
  }

  await restoreCaptureTraceOverlayForRecords(
    activeTab.id,
    uniqueRecordIds,
  );

  const settings = await getCaptureSettings();
  const resolvedEnableAiRelevancePrefilter =
    enableAiRelevancePrefilter ?? settings.enableAiRelevancePrefilter ?? false;
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings({
    ...settings,
    enableCommentLeadsFilter:
      enableCommentLeadsFilter ??
      settings.enableCommentLeadsFilterOnDetailCapture ??
      settings.enableCommentLeadsFilter,
  });
  const normalizedCommentsMaxDetectedItems = normalizeCommentsMaxDetectedItems(
    commentsMaxDetectedItems ?? commentsMaxItems,
    settings.detailCommentsMaxDetectedItems ?? settings.commentsMaxDetectedItems,
  );
  const normalizedDetailNavTimeoutMs = normalizePositiveInteger(
    detailNavTimeoutMs ?? settings.detailNavTimeoutMs,
    DETAIL_CAPTURE_NAV_TIMEOUT_MS,
  );
  const normalizedDetailAfterNavWaitMs = normalizePositiveInteger(
    detailAfterNavWaitMs ?? settings.detailAfterNavWaitMs,
    DETAIL_CAPTURE_AFTER_NAV_WAIT_MS,
  );
  const normalizedProfileAfterNavWaitMs = normalizePositiveInteger(
    profileAfterNavWaitMs ?? settings.profileAfterNavWaitMs,
    PROFILE_AFTER_NAV_WAIT_MS,
  );

  // 增量采集:补采前问后端「这些笔记哪些已采全(detailCaptureStatus=done)」,已采全的直接跳过,
  // 不再进详情/主页 → 大幅减少重复导航(防风控 + 提速)。查询失败则不跳过(顶多多采几条,不影响主流程)。
  const resolvedSkipCaptured =
    skipAlreadyCaptured ?? settings.skipAlreadyCapturedOnDetailCapture ?? true;
  let skipRecordIdSet = new Set();
  if (resolvedSkipCaptured) {
    try {
      const idPairs = [];
      let probePlatform = '';
      for (const rid of uniqueRecordIds) {
        const rec = await getRecord(rid);
        if (!rec) continue;
        if (!probePlatform) probePlatform = resolveRecordIdentityPlatform(rec);
        const ext = resolveRecordDetailNoteId(rec);
        if (ext) {
          idPairs.push({
            recordId: rid,
            externalId: String(ext),
            payload: rec.payload,
          });
        }
      }
      const candidateExtIds = new Set(idPairs.map((p) => p.externalId));

      // ① 本地已采全(detailCaptureStatus=done)的 external_id —— 覆盖「循环内 / 同会话」重复,
      //    不依赖同步到后台(无人值守循环不会每轮自动同步,所以第2轮跳第1轮要靠这个)。
      const localDone = new Set();
      try {
        const pool = await getDataPool();
        for (const rec of pool?.records || []) {
          if (String(rec?.payload?.detailCaptureStatus || '') !== 'done') continue;
          const ext = resolveRecordDetailNoteId(rec);
          if (ext && candidateExtIds.has(String(ext))) {
            const normalizedExt = String(ext);
            localDone.add(normalizedExt);
          }
        }
      } catch (poolError) {
        console.warn('[CaptureSync] 本地已采预检失败(忽略):', poolError);
      }

      // ② 后台已采全的 —— 覆盖「跨夜 / 跨会话」(需之前同步过)
      const {captured} = await checkCapturedExternalIds({
        platform: probePlatform,
        externalIds: idPairs.map((p) => p.externalId),
      });
      const capturedSet = new Set(captured);

      const nextSkipRecordIds = [];
      idPairs.forEach((p) => {
        const isCaptured =
          capturedSet.has(p.externalId) || localDone.has(p.externalId);
        if (!isCaptured) return;
        nextSkipRecordIds.push(p.recordId);
      });

      skipRecordIdSet = new Set(nextSkipRecordIds);

      // 给跳过的记录打「已采过」标记,卡片据此显示"已采过"而非"未执行采集增强"
      for (const p of idPairs) {
        if (
          skipRecordIdSet.has(p.recordId) &&
          p.payload &&
          !p.payload.detailAlreadyCaptured
        ) {
          try {
            await updateRecord(p.recordId, {
              payload: { ...p.payload, detailAlreadyCaptured: true },
            });
          } catch (markError) {
            console.warn('[CaptureSync] 标记已采过失败(忽略):', markError);
          }
        }
      }
    } catch (error) {
      console.warn('[CaptureSync] 增量采集预检失败(忽略,照常补采):', error);
      skipRecordIdSet = new Set();
    }
  }

  // 可选 AI 前置筛选只作用于 keyword_notes。它在任何详情工作页打开前，
  // 批量提交标题/作者/类型/时间等列表文字给后台；DeepSeek、提示词和密钥
  // 均留在后台。接口失败、超时、输出不完整或灰区一律安全放行。
  let relevancePrefilterResult = {
    enabled: Boolean(resolvedEnableAiRelevancePrefilter),
    evaluatedCount: 0,
    skippedCount: 0,
    failedOpenCount: 0,
    retryCount: 0,
    retriedItemCount: 0,
    timeoutCount: 0,
    skippedRecordIds: [],
    decisions: [],
    canceled: false,
  };
  let relevancePrefilterSkipRecordIdSet = new Set();
  const recordsForRelevancePrefilter = [];
  if (resolvedEnableAiRelevancePrefilter) {
    for (const recordId of uniqueRecordIds) {
      if (skipRecordIdSet.has(recordId)) continue;
      const record = await getRecord(recordId);
      if (record) recordsForRelevancePrefilter.push(record);
    }
    if (recordsForRelevancePrefilter.length > 0) {
      await reportProgressFailSoft(onProgress, {
        phase: 'detail_ai_prefilter_start',
        message: `AI 正在预判 ${recordsForRelevancePrefilter.length} 条搜索结果的相关性...`,
        current: 0,
        total: uniqueRecordIds.length,
        candidateCount: recordsForRelevancePrefilter.length,
      }, 'detail ai prefilter start');
      relevancePrefilterResult = await evaluateRelevancePrefilterRecords(
        recordsForRelevancePrefilter,
        {
          enabled: true,
          keyword: relevanceKeyword,
          threshold:
            settings.aiRelevancePrefilterThreshold ??
            RELEVANCE_PREFILTER_DEFAULT_THRESHOLD,
          shouldStop,
        },
      );
      relevancePrefilterSkipRecordIdSet = new Set(
        relevancePrefilterResult.skippedRecordIds,
      );

      const evaluatedAt = Date.now();
      for (const decision of relevancePrefilterResult.decisions) {
        const latestRecord = await getRecord(decision.recordId);
        if (!latestRecord) continue;
        try {
          const latestPayload =
            latestRecord.payload && typeof latestRecord.payload === 'object'
              ? latestRecord.payload
              : {};
          const hasCompletedDetail =
            String(latestPayload.detailCaptureStatus || '')
              .trim()
              .toLowerCase() === DETAIL_CAPTURE_STATUS.DONE &&
            latestPayload.detailPayload &&
            typeof latestPayload.detailPayload === 'object';
          const nextPayload =
            decision.shouldSkip && !hasCompletedDetail
              ? applyDetailCapturePatch(
                  latestPayload,
                  createDetailCapturePatch({
                    status: DETAIL_CAPTURE_STATUS.FILTERED,
                    finishedAt: evaluatedAt,
                    error: '',
                    failureCode: '',
                    failureStage: '',
                    failureCategory: '',
                    diagnosticMessage: '',
                  }),
                )
              : {...latestPayload};
          await updateRecord(decision.recordId, {
            payload: {
              ...nextPayload,
              aiRelevancePrefilter: {
                status: decision.status,
                modelDecision: decision.modelDecision,
                tenantRelevance: decision.tenantRelevance,
                confidence: decision.confidence,
                protectedSignal: Boolean(decision.protectedSignal),
                reason: decision.reason,
                keyword: decision.keyword,
                stage: 'list',
                promptVersion: 'prefilter-list-v3',
                executionDisposition: decision.shouldSkip
                  ? 'skip_expensive'
                  : 'collect_full',
                modelExecutionDisposition:
                  decision.executionDisposition || null,
                evaluatedAt,
              },
            },
          });
        } catch (error) {
          console.warn(
            '[CaptureSync] AI relevance audit update failed (ignored):',
            error?.message || error,
          );
        }
      }
      await reportProgressFailSoft(onProgress, {
        phase: 'detail_ai_prefilter_done',
        message:
          relevancePrefilterResult.failedOpenCount > 0
            ? `AI 预判完成：${relevancePrefilterResult.failedOpenCount} 条超时或异常，已安全继续采集`
            : relevancePrefilterResult.skippedCount > 0
            ? `AI 预判完成：高置信度跳过 ${relevancePrefilterResult.skippedCount} 条，其余继续采集`
            : relevancePrefilterResult.retryCount > 0
              ? `AI 预判完成：拆批重试 ${relevancePrefilterResult.retryCount} 次后完成，继续采集`
            : 'AI 预判完成：没有高置信度无关项，继续原采集流程',
        current: 0,
        total: uniqueRecordIds.length,
        candidateCount: recordsForRelevancePrefilter.length,
        evaluatedCount: relevancePrefilterResult.evaluatedCount,
        aiFilteredCount: relevancePrefilterResult.skippedCount,
        failedOpenCount: relevancePrefilterResult.failedOpenCount,
        retryCount: relevancePrefilterResult.retryCount,
        retriedItemCount: relevancePrefilterResult.retriedItemCount,
        timeoutCount: relevancePrefilterResult.timeoutCount,
      }, 'detail ai prefilter done');
    }
  }

  if (relevancePrefilterResult.canceled) {
    return {
      ok: false,
      canceled: true,
      securityBlocked: false,
      total: uniqueRecordIds.length,
      processedCount: 0,
      successCount: 0,
      failedCount: 0,
      filteredCount: 0,
      skippedCount: 0,
      results: [],
      diagnostics: {stageTrace: []},
      error: null,
    };
  }

  const preDetailSkipRecordIdSet = new Set([
    ...skipRecordIdSet,
    ...relevancePrefilterSkipRecordIdSet,
  ]);
  const relevanceDecisionByRecordId = new Map(
    relevancePrefilterResult.decisions.map((decision) => [
      decision.recordId,
      decision,
    ]),
  );

  // 全部已采过或被 AI 高置信度过滤 → 不必开补采标签页。
  if (
    preDetailSkipRecordIdSet.size > 0 &&
    preDetailSkipRecordIdSet.size === uniqueRecordIds.length
  ) {
    const skippedResults = [];
    let aiFilteredCount = 0;
    let alreadyCapturedCount = 0;
    for (let index = 0; index < uniqueRecordIds.length; index += 1) {
      const recordId = uniqueRecordIds[index];
      const record = await getRecord(recordId);
      const captureTraceFields = buildCaptureTraceEventFields(record);
      const markerLabel = formatCaptureTraceMarker(
        captureTraceFields,
        index + 1,
      );
      const progressLabel = formatCaptureTraceProgressLabel(
        captureTraceFields,
        index + 1,
        uniqueRecordIds.length,
      );
      if (relevancePrefilterSkipRecordIdSet.has(recordId)) {
        const decision = relevanceDecisionByRecordId.get(recordId) || {};
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'filtered',
          record,
          tabId: activeTab?.id,
        });
        aiFilteredCount += 1;
        skippedResults.push({
          recordId,
          ok: true,
          filtered: true,
          reason: 'ai_relevance_filtered',
          message: `${markerLabel} AI 高置信度判定无关，已跳过采集增强`,
          aiRelevanceConfidence: decision.confidence ?? null,
          aiRelevanceReason: decision.reason || '',
          ...captureTraceFields,
        });
        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_filtered',
            message: `${progressLabel}：AI 高置信度判定与关键词「${decision.keyword || relevanceKeyword || ''}」无关，已跳过详情、评论和博主采集`,
            recordId,
            current: index + 1,
            total: uniqueRecordIds.length,
            successCount: 0,
            failedCount: 0,
            filteredCount: aiFilteredCount,
            skippedCount: alreadyCapturedCount,
            aiFilteredCount,
            aiRelevanceConfidence: decision.confidence ?? null,
            aiRelevanceReason: decision.reason || '',
            runnerTabId: activeTab?.id || null,
            ...captureTraceFields,
          }, 'detail ai relevance filtered without runner');
        }
      } else {
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'skipped',
          record,
          tabId: activeTab?.id,
        });
        alreadyCapturedCount += 1;
        skippedResults.push({
          recordId,
          ok: true,
          reason: 'already_captured',
          message: `${markerLabel} 已采过，跳过`,
          ...captureTraceFields,
        });
        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_skipped',
            message: `${progressLabel}：之前已采过，跳过（增量采集）`,
            recordId,
            current: index + 1,
            total: uniqueRecordIds.length,
            successCount: 0,
            failedCount: 0,
            filteredCount: aiFilteredCount,
            skippedCount: alreadyCapturedCount,
            aiFilteredCount,
            runnerTabId: activeTab?.id || null,
            ...captureTraceFields,
          }, 'detail item skipped without runner');
        }
      }
    }
    if (onProgress) {
      await reportProgressFailSoft(onProgress, {
        phase: 'detail_batch_done',
        message:
          aiFilteredCount > 0
            ? `无需打开详情：AI 已过滤 ${aiFilteredCount} 条无关结果${alreadyCapturedCount > 0 ? `，另有 ${alreadyCapturedCount} 条之前已采过` : ''}`
            : `全部 ${uniqueRecordIds.length} 条均已采过,跳过补采`,
        current: uniqueRecordIds.length,
        total: uniqueRecordIds.length,
        successCount: 0,
        failedCount: 0,
        filteredCount: aiFilteredCount,
        skippedCount: alreadyCapturedCount,
        aiFilteredCount,
      }, 'detail batch done');
    }
    return {
      ok: true,
      canceled: false,
      securityBlocked: false,
      total: uniqueRecordIds.length,
      processedCount: uniqueRecordIds.length,
      successCount: 0,
      failedCount: 0,
      filteredCount: aiFilteredCount,
      skippedCount: alreadyCapturedCount,
      aiFilteredCount,
      results: skippedResults,
      diagnostics: { stageTrace: [] },
      error: null,
    };
  }

  const results = [];
  const bloggerMetricsCache = new Map();
  let successCount = 0;
  let failedCount = 0;
  let filteredCount = 0;
  let skippedCount = 0; // 增量采集:之前已采过、本次跳过的条数(单列,不混入"过滤")
  let securityBlocked = false; // 撞上平台安全限制/验证页 → 立即停整批,别再硬刷
  let integrityBlocked = false; // 任一作品身份无法闭环 → 停整批,禁止继续写入
  let runnerInterrupted = false; // owned 工作页中断即停批，交给外层用全新工作页最多重试一次
  let detailKeywordFilterEnabled = false;
  let detailKeywordFilteredCount = 0;
  let canceled = false;
  let runnerContext = null;
  const runnerContexts = [];
  let detailPrefetchPipeline = null;
  let doubleBufferFallbackReason = '';
  let activeDetailItemContext = null;
  let batchUnexpectedError = null;
  const fatalCancelRequestedTabIds = new Set();
  const detailRunnerRecoveryAttemptsByRecordId = new Map();
  let detailRunnerRecoveryCount = 0;

  // 先确认本批平台，再决定是否启用双工作页。抖音恢复为已验证稳定的
  // “来源搜索页 + 一个独立详情工作页”串行模式；来源页绝不兼任 worker。
  // 小红书继续保留现有 A/B 双工作页。
  const detailBatchPlatforms = new Set([
    detectPlatformFromUrl(String(activeTab?.url || '')),
  ]);
  const douyinDetailPathByRecordId = new Map();
  const douyinSearchModalUrlByRecordId = new Map();
  const douyinReadyEntryUrlByRecordId = new Map();
  for (const recordId of uniqueRecordIds) {
    try {
      const record = await getRecord(recordId);
      const recordUrl = resolveRecordNoteUrl(record);
      const recordPlatform = String(
        record?.platform || detectPlatformFromUrl(recordUrl),
      )
        .trim()
        .toLowerCase();
      if (recordPlatform) detailBatchPlatforms.add(recordPlatform);
      if (recordPlatform === 'douyin') {
        const noteId = resolveRecordDetailNoteId(record);
        douyinDetailPathByRecordId.set(
          String(recordId),
          resolveRecordDetailNotePath(record),
        );
        douyinSearchModalUrlByRecordId.set(
          String(recordId),
          buildDouyinRecordSearchModalUrl(record, noteId),
        );
      }
    } catch (error) {
      console.warn(
        '[CaptureSync] detail batch platform lookup failed (ignored):',
        recordId,
        error?.message || error,
      );
    }
  }
  const detailBatchContainsDouyin = detailBatchPlatforms.has('douyin');
  try {
    runnerContext = await prepareDetailBatchRunnerContext({
      sourceTab: activeTab,
      runnerMode: DETAIL_RUNNER_MODE.DEDICATED_TAB,
      indexOffset: 1,
    });
    runnerContexts.push(runnerContext);
  } catch (error) {
    return await buildSetupFailureResult({
      code: 'RUNNER_TAB_UNAVAILABLE',
      message: error?.message || '初始化详情采集工作页失败，请稍后重试',
      sourceTabId: activeTab?.id || null,
      aiFilteredRecordIds: relevancePrefilterSkipRecordIdSet,
      alreadyCapturedRecordIds: skipRecordIdSet,
      relevanceDecisionById: relevanceDecisionByRecordId,
    });
  }

  const normalizedCaptureTaskId = normalizeCaptureTaskId(captureTaskId);
  const taskTabRegistration = await registerCaptureTaskTab({
    taskId: normalizedCaptureTaskId,
    tabId: runnerContext.runnerTabId,
    role: 'detail_worker',
  });
  const requiredTaskRegistrationMissing =
    Boolean(normalizedCaptureTaskId) &&
    (taskTabRegistration?.ok !== true || taskTabRegistration?.skipped === true);
  if (taskTabRegistration?.ok === false || requiredTaskRegistrationMissing) {
    await closeOwnedDetailRunnerTab({
      runnerTabId: runnerContext.runnerTabId,
      sourceTabId: runnerContext.sourceTabId,
      ownsRunnerTab: runnerContext.ownsRunnerTab,
    }).catch(() => false);
    return await buildSetupFailureResult({
      code: 'TASK_TAB_GROUP_UNAVAILABLE',
      message:
        taskTabRegistration?.response?.error?.message ||
        (taskTabRegistration?.skipped
          ? '当前详情采集任务已失去浏览器接管状态'
          : '') ||
        '详情采集工作页无法加入当前任务标签组',
      sourceTabId: runnerContext.sourceTabId,
      runnerTabId: runnerContext.runnerTabId,
      aiFilteredRecordIds: relevancePrefilterSkipRecordIdSet,
      alreadyCapturedRecordIds: skipRecordIdSet,
      relevanceDecisionById: relevanceDecisionByRecordId,
    });
  }

  const remainingDetailCount = Math.max(
    0,
    uniqueRecordIds.length - preDetailSkipRecordIdSet.size,
  );
  const allowDetailDoubleBuffer = !detailBatchContainsDouyin;
  if (
    normalizedCaptureTaskId &&
    remainingDetailCount >= DETAIL_PREFETCH_WORKER_COUNT &&
    !allowDetailDoubleBuffer
  ) {
    doubleBufferFallbackReason =
      '抖音使用单工作页，避免自动连播导致作品错配';
  }
  if (
    normalizedCaptureTaskId &&
    allowDetailDoubleBuffer &&
    remainingDetailCount >= DETAIL_PREFETCH_WORKER_COUNT
  ) {
    let standbyContext = null;
    try {
      standbyContext = await prepareDetailBatchRunnerContext({
        sourceTab: activeTab,
        runnerMode: DETAIL_RUNNER_MODE.DEDICATED_TAB,
        indexOffset: 2,
      });
      if (
        runnerContexts.some(
          (context) => context.runnerTabId === standbyContext.runnerTabId,
        )
      ) {
        throw new Error('双缓冲工作页编号冲突');
      }
      const standbyRegistration = await registerCaptureTaskTab({
        taskId: normalizedCaptureTaskId,
        tabId: standbyContext.runnerTabId,
        role: 'detail_worker',
      });
      const standbyRegistrationMissing =
        standbyRegistration?.ok !== true ||
        standbyRegistration?.skipped === true;
      if (standbyRegistrationMissing) {
        const error = new Error(
          standbyRegistration?.response?.error?.message ||
            '预加载工作页未能加入当前任务标签组',
        );
        error.code = 'DETAIL_STANDBY_REGISTRATION_FAILED';
        throw error;
      }
      runnerContexts.push(standbyContext);
    } catch (error) {
      doubleBufferFallbackReason =
        error?.message || '第二个工作页不可用，已降级为单工作页';
      if (standbyContext) {
        await closeOwnedDetailRunnerTab({
          runnerTabId: standbyContext.runnerTabId,
          sourceTabId: standbyContext.sourceTabId,
          ownsRunnerTab: standbyContext.ownsRunnerTab,
        }).catch(() => false);
      }
      console.warn(
        '[CaptureSync] detail double buffer unavailable, using one worker:',
        error,
      );
    }
  }

  const shouldStopDetailBatch = () => {
    if (detailPrefetchPipeline?.getFatalError()) return true;
    if (typeof shouldStop !== 'function') return false;
    try {
      return Boolean(shouldStop());
    } catch {
      return true;
    }
  };

  const createCurrentDetailPrefetchPipeline = () => createDetailPrefetchPipeline({
    workerTabs: runnerContexts.map((context, index) => ({
      tabId: context.runnerTabId,
      label: `工作页 ${String.fromCharCode(65 + index)}`,
    })),
    minNavigationGapMs: DETAIL_PREFETCH_NAV_GAP_MS,
    stopTimeoutMs: DETAIL_PREFETCH_STOP_TIMEOUT_MS,
    shouldStop,
    isFatalError: isDetailSecurityBlockError,
    navigate: async ({
      tabId,
      recordId,
      url,
      shouldStop: pipelineShouldStop,
    }) => {
      const isDouyinDetailNavigation =
        detectPlatformFromUrl(url) === 'douyin';
      if (isDouyinDetailNavigation) {
        douyinReadyEntryUrlByRecordId.delete(String(recordId));
      }
      const navigationCandidates = isDouyinDetailNavigation
        ? buildDouyinDetailNavigationCandidates(
            url,
            douyinSearchModalUrlByRecordId.get(String(recordId)) || '',
            douyinDetailPathByRecordId.get(String(recordId)) || 'unknown',
          )
        : [url];
      let lastRecoverableError = null;
      const douyinNavigationDeadline = isDouyinDetailNavigation
        ? Date.now() + Math.min(
            normalizedDetailNavTimeoutMs,
            DOUYIN_DETAIL_NAV_TOTAL_TIMEOUT_MS,
          )
        : 0;

      for (const candidateUrl of navigationCandidates) {
        try {
          const remainingDouyinBudgetMs = isDouyinDetailNavigation
            ? Math.max(0, douyinNavigationDeadline - Date.now())
            : normalizedDetailNavTimeoutMs;
          if (isDouyinDetailNavigation && remainingDouyinBudgetMs <= 0) {
            const budgetError = new Error('抖音详情页在限定时间内未完成加载');
            budgetError.code = 'DETAIL_NAVIGATION_TIMEOUT';
            throw budgetError;
          }
          await openUrlInTab(tabId, candidateUrl, {
            timeoutMs: isDouyinDetailNavigation
              ? Math.min(
                  normalizedDetailNavTimeoutMs,
                  DOUYIN_DETAIL_NAV_CANDIDATE_TIMEOUT_MS,
                  remainingDouyinBudgetMs,
                )
              : normalizedDetailNavTimeoutMs,
            shouldStop: pipelineShouldStop,
            active: isDouyinDetailNavigation,
          });
          const remainingProbeBudgetMs = isDouyinDetailNavigation
            ? Math.max(0, douyinNavigationDeadline - Date.now())
            : undefined;
          if (isDouyinDetailNavigation && remainingProbeBudgetMs <= 0) {
            const budgetError = new Error('抖音详情页在限定时间内未完成加载');
            budgetError.code = 'DETAIL_NAVIGATION_TIMEOUT';
            throw budgetError;
          }
          const preloadResult = isDouyinDetailNavigation
            ? await probeDouyinNavigationEntry(tabId, {
                targetUrl: candidateUrl,
                shouldStop: pipelineShouldStop,
                timeoutMs: Math.min(
                  DOUYIN_DETAIL_READY_PROBE_TIMEOUT_MS,
                  remainingProbeBudgetMs,
                ),
              })
            : await probeDetailPreloadSafety(tabId, {
                targetUrl: candidateUrl,
                shouldStop: pipelineShouldStop,
              });
          if (isDouyinDetailNavigation) {
            const expectedNoteId = extractNoteId(candidateUrl);
            const entryKind = /\/note\/\d{8,}/i.test(candidateUrl)
              ? 'note_direct'
              : /\/video\/\d{8,}/i.test(candidateUrl)
                ? 'video_direct'
                : 'record_search_modal';
            void recordDiagnosticStage({
              stageKey: 'capture.douyin_detail_identity',
              label: '抖音作品身份确认',
              status: 'completed',
              metrics: {
                recordId: String(recordId || ''),
                expectedNoteId: String(expectedNoteId || ''),
                currentNoteId: String(preloadResult?.currentNoteId || ''),
                entryKind,
                targetMatched: preloadResult?.targetMatched === true,
                visibleDetailBound:
                  preloadResult?.hasBoundDetailRoot === true,
                directRouteAccepted:
                  preloadResult?.directRouteAccepted === true,
                hydrationDeferred:
                  preloadResult?.hydrationDeferred === true,
              },
              taskContext: getActiveTaskContext(),
              featureKey: 'capture.enhancement',
              parentFeatureKey: 'capture.enhancement',
              source: 'capture-sync',
            }).catch(() => null);
            douyinReadyEntryUrlByRecordId.set(
              String(recordId),
              candidateUrl,
            );
          }
          return;
        } catch (error) {
          const recoverable =
            isDouyinDetailNavigation &&
            (error?.code === 'DETAIL_NAVIGATION_TIMEOUT' ||
              error?.code === 'DOUYIN_DETAIL_NOT_READY' ||
              error?.code === 'DOUYIN_CONTENT_UNAVAILABLE');
          if (!recoverable) {
            throw error;
          }
          lastRecoverableError = error;
        }
      }

      throw lastRecoverableError || new Error('抖音详情页未完成加载');
    },
    onTransition: ({type, slot, snapshot, error}) => {
      const fatalNavigationFailure =
        (type === 'navigation_failed' ||
          type === 'external_navigation_failed') &&
        isDetailSecurityBlockError(error);
      if (fatalNavigationFailure) {
        securityBlocked = true;
        const activeTabId = Number(snapshot?.activeTabId);
        if (
          Number.isSafeInteger(activeTabId) &&
          activeTabId > 0 &&
          !fatalCancelRequestedTabIds.has(activeTabId)
        ) {
          fatalCancelRequestedTabIds.add(activeTabId);
          void requestCaptureCancelInTabFailSoft(
            activeTabId,
            'standby_security_blocked',
          );
        }
      }
      if (!onProgress || !slot) return;
      if (type === 'navigation_queued' && slot.mode === 'foreground') {
        const context = activeDetailItemContext || {};
        void reportProgressFailSoft(onProgress, {
          phase: 'detail_item_opening',
          message: `${context.progressLabel || slot.label}：已找到作品链接，等待工作页打开详情...`,
          recordId: slot.recordId,
          current: context.current || 0,
          total: uniqueRecordIds.length,
          runnerTabId: slot.tabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: snapshot?.activeTabId || null,
          workerMode: snapshot?.mode || '',
          workerRevision: snapshot?.revision || 0,
          workerStates: snapshot?.slots || [],
        }, 'detail foreground navigation queued');
      } else if (type === 'navigation_started' && slot.mode === 'foreground') {
        const context = activeDetailItemContext || {};
        void reportProgressFailSoft(onProgress, {
          phase: 'detail_item_opening',
          message: `${context.progressLabel || slot.label}：已找到作品链接，正在工作页打开并确认详情...`,
          recordId: slot.recordId,
          current: context.current || 0,
          total: uniqueRecordIds.length,
          runnerTabId: slot.tabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: snapshot?.activeTabId || null,
          workerMode: snapshot?.mode || '',
          workerRevision: snapshot?.revision || 0,
          workerStates: snapshot?.slots || [],
        }, 'detail foreground navigation started');
      } else if (type === 'navigation_started' && slot.mode === 'prefetch') {
        void reportProgressFailSoft(onProgress, {
          phase: 'detail_item_prefetch_loading',
          message: `${slot.label} 正在预加载下一条详情...`,
          recordId: slot.recordId,
          runnerTabId: slot.tabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: snapshot?.activeTabId || null,
          workerRevision: snapshot?.revision || 0,
          workerStates: snapshot?.slots || [],
        }, 'detail prefetch loading');
      } else if (type === 'navigation_ready' && slot.mode === 'prefetch') {
        void reportProgressFailSoft(onProgress, {
          phase: 'detail_item_prefetch_ready',
          message: `${slot.label} 已加载下一条，等待当前采集完成`,
          recordId: slot.recordId,
          runnerTabId: slot.tabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: snapshot?.activeTabId || null,
          workerMode: snapshot?.mode || '',
          workerRevision: snapshot?.revision || 0,
          workerStates: snapshot?.slots || [],
        }, 'detail prefetch ready');
      } else if (type === 'collection_finished') {
        void reportProgressFailSoft(onProgress, {
          phase: 'detail_worker_released',
          message: `${slot.label} 已完成当前详情，等待下一条`,
          runnerTabId: slot.tabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: snapshot?.activeTabId || null,
          workerMode: snapshot?.mode || '',
          workerRevision: snapshot?.revision || 0,
          workerStates: snapshot?.slots || [],
        }, 'detail worker released');
      }
    },
  });
  const plannedDetailWorkerCount = runnerContexts.length;
  detailPrefetchPipeline = createCurrentDetailPrefetchPipeline();

  const recreateInterruptedDetailRunners = async ({
    recordId = '',
    recordPlatform = '',
    expectedNoteId = '',
    current = 0,
    total = uniqueRecordIds.length,
  } = {}) => {
    const normalizedRecordId = String(recordId || '').trim();
    const normalizedRecordPlatform = String(recordPlatform || '')
      .trim()
      .toLowerCase();
    const normalizedExpectedNoteId =
      normalizedRecordPlatform === 'douyin'
        ? extractDouyinDetailGuardItemId(expectedNoteId)
        : '';
    const supportedPlatform =
      normalizedRecordPlatform === 'xiaohongshu' ||
      normalizedRecordPlatform === 'douyin';
    const itemRecoveryCount = Math.max(
      0,
      Number(detailRunnerRecoveryAttemptsByRecordId.get(normalizedRecordId)) ||
        0,
    );
    if (
      !supportedPlatform ||
      !normalizedRecordId ||
      (normalizedRecordPlatform === 'douyin' && !normalizedExpectedNoteId) ||
      detailRunnerRecoveryCount >= DETAIL_RUNNER_RECREATE_MAX_PER_BATCH ||
      itemRecoveryCount >= DETAIL_RUNNER_RECREATE_MAX_PER_ITEM ||
      shouldStopDetailBatch()
    ) {
      return false;
    }

    const previousContexts = [...runnerContexts];
    const previousPipeline = detailPrefetchPipeline;
    await previousPipeline?.stop?.().catch(() => null);
    try {
      await closeOwnedDetailRunnerTabs(previousContexts);
    } catch (error) {
      console.warn(
        '[CaptureSync] close interrupted detail workers failed:',
        error?.message || error,
      );
      // 无法确认旧工作页已关闭时不再创建新页，避免并发导航数量失控。
      return false;
    }

    const replacementContexts = [];
    let replacementError = null;
    for (let index = 0; index < plannedDetailWorkerCount; index += 1) {
      let replacementContext = null;
      try {
        replacementContext = await prepareDetailBatchRunnerContext({
          sourceTab: activeTab,
          runnerMode: DETAIL_RUNNER_MODE.DEDICATED_TAB,
          indexOffset: index + 1,
        });
        const registration = await registerCaptureTaskTab({
          taskId: normalizedCaptureTaskId,
          tabId: replacementContext.runnerTabId,
          role: 'detail_worker',
        });
        const registrationMissing =
          Boolean(normalizedCaptureTaskId) &&
          (registration?.ok !== true || registration?.skipped === true);
        if (registration?.ok === false || registrationMissing) {
          const error = new Error(
            registration?.response?.error?.message ||
              '重建的详情工作页无法加入当前任务标签组',
          );
          error.code = 'TASK_TAB_GROUP_UNAVAILABLE';
          throw error;
        }
        replacementContexts.push(replacementContext);
      } catch (error) {
        replacementError = error;
        if (replacementContext) {
          await closeOwnedDetailRunnerTab({
            runnerTabId: replacementContext.runnerTabId,
            sourceTabId: replacementContext.sourceTabId,
            ownsRunnerTab: replacementContext.ownsRunnerTab,
          }).catch(() => false);
        }
        if (index > 0 && replacementContexts.length > 0) {
          doubleBufferFallbackReason =
            error?.message || '第二个重建工作页不可用，已降级为单工作页';
        }
        break;
      }
    }

    if (replacementContexts.length === 0) {
      detailPrefetchPipeline = previousPipeline;
      // 旧工作页在重建前已经关闭，避免 finally 再次关闭同一批 tab。
      runnerContexts.splice(0, runnerContexts.length);
      console.warn(
        '[CaptureSync] recreate interrupted detail worker failed:',
        replacementError?.message || replacementError || 'unknown error',
      );
      return false;
    }

    runnerContexts.splice(0, runnerContexts.length, ...replacementContexts);
    runnerContext = runnerContexts[0];
    detailRunnerRecoveryCount += 1;
    detailRunnerRecoveryAttemptsByRecordId.set(
      normalizedRecordId,
      itemRecoveryCount + 1,
    );
    detailPrefetchPipeline = createCurrentDetailPrefetchPipeline();
    await reportProgressFailSoft(onProgress, {
      phase: 'detail_runner_recreated',
      message: `${normalizedRecordPlatform === 'douyin' ? '抖音' : '小红书'}详情工作页已自动重建，正在重试当前条`,
      recordId: normalizedRecordId,
      recordPlatform: normalizedRecordPlatform,
      expectedNoteId: normalizedExpectedNoteId,
      current,
      total,
      runnerRecoveryCount: detailRunnerRecoveryCount,
      runnerRecoveryMax: DETAIL_RUNNER_RECREATE_MAX_PER_BATCH,
      runnerTabId: runnerContext.runnerTabId,
      runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
      workerMode:
        runnerContexts.length > 1 ? 'double_buffer' : 'single_worker',
      workerRevision: detailPrefetchPipeline.snapshot().revision,
      workerStates: detailPrefetchPipeline.snapshot().slots,
    }, 'detail runner recreated');
    return true;
  };

  const discardPrefetchForRecord = (recordId) => {
    const normalizedRecordId = String(recordId || '').trim();
    if (!normalizedRecordId) return false;
    const slot = detailPrefetchPipeline
      .snapshot()
      .slots.find(
        (candidate) =>
          candidate.recordId === normalizedRecordId &&
          candidate.url &&
          candidate.state !== 'collecting',
      );
    return slot
      ? detailPrefetchPipeline.discard({
          recordId: normalizedRecordId,
          url: slot.url,
        })
      : false;
  };

  const throwIfDetailPrefetchFatal = () => {
    const error = detailPrefetchPipeline?.getFatalError() || null;
    if (!error) return;
    securityBlocked = true;
    throw error;
  };

  await reportProgressFailSoft(onProgress, {
    phase: 'detail_batch_start',
    message:
      runnerContexts.length > 1
        ? `已启动双工作页：A 采集、B 预加载，共 ${uniqueRecordIds.length} 条`
        : `已启动 1 个详情采集工作页，共 ${uniqueRecordIds.length} 条${doubleBufferFallbackReason ? '（双缓冲已安全降级）' : ''}`,
    current: 0,
    total: uniqueRecordIds.length,
    successCount,
    failedCount,
    runnerTabId: runnerContext.runnerTabId,
    runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
    activeRunnerTabId: null,
    workerMode:
      runnerContexts.length > 1 ? 'double_buffer' : 'single_worker',
    workerRevision: detailPrefetchPipeline.snapshot().revision,
    workerStates: detailPrefetchPipeline.snapshot().slots,
    fallbackReason: doubleBufferFallbackReason,
    sourceTabId: runnerContext.sourceTabId,
    runnerRole: 'detail_worker',
  }, 'detail batch start');

  // 增量采集:开跑前先告诉用户为什么只补一部分(否则客户看到跳过一脸懵)
  if (onProgress && preDetailSkipRecordIdSet.size > 0) {
    const toCaptureCount =
      uniqueRecordIds.length - preDetailSkipRecordIdSet.size;
    onProgress({
      phase: 'detail_skip_summary',
      message: `采集增强：共 ${uniqueRecordIds.length} 条，AI 过滤 ${relevancePrefilterSkipRecordIdSet.size} 条，之前已采过 ${skipRecordIdSet.size} 条，本次补采 ${toCaptureCount} 条`,
      current: 0,
      total: uniqueRecordIds.length,
      skippedCount: skipRecordIdSet.size,
      aiFilteredCount: relevancePrefilterSkipRecordIdSet.size,
      toCaptureCount,
      runnerTabId: runnerContext.runnerTabId,
    }, 'detail skip summary');
  }

  try {
    for (let index = 0; index < uniqueRecordIds.length; index += 1) {
      if (shouldStopDetailBatch()) {
        if (detailPrefetchPipeline.getFatalError()) {
          securityBlocked = true;
        } else {
          canceled = true;
        }
        break;
      }

      const recordId = uniqueRecordIds[index];
      const current = index + 1;
      const record = await getRecord(recordId);
      const captureTraceFields = buildCaptureTraceEventFields(record);
      const markerLabel = formatCaptureTraceMarker(
        captureTraceFields,
        current,
      );
      const progressLabel = formatCaptureTraceProgressLabel(
        captureTraceFields,
        current,
        uniqueRecordIds.length,
      );
      activeDetailItemContext = {
        recordId,
        record,
        current,
        noteUrl: '',
        startedAt: 0,
        activeStage: 'prepare',
        captureTraceFields,
        markerLabel,
        progressLabel,
      };

      // AI 只真正执行 high-confidence skip。灰区、need_detail、接口错误
      // 和超时都不会进入这个分支，仍沿用下面的原详情采集流程。
      if (relevancePrefilterSkipRecordIdSet.has(recordId)) {
        const decision = relevanceDecisionByRecordId.get(recordId) || {};
        discardPrefetchForRecord(recordId);
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'filtered',
          record,
          tabId: runnerContext.sourceTabId,
        });
        filteredCount += 1;
        results.push({
          recordId,
          ok: true,
          filtered: true,
          reason: 'ai_relevance_filtered',
          message: `${markerLabel} AI 高置信度判定无关，已跳过采集增强`,
          aiRelevanceConfidence: decision.confidence ?? null,
          aiRelevanceReason: decision.reason || '',
          ...captureTraceFields,
        });
        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_filtered',
            message: `${progressLabel}：AI 高置信度判定与关键词「${decision.keyword || relevanceKeyword || ''}」无关，已跳过详情、评论和博主采集`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            aiFilteredCount: filteredCount,
            aiRelevanceConfidence: decision.confidence ?? null,
            aiRelevanceReason: decision.reason || '',
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail ai relevance filtered');
        }
        activeDetailItemContext = null;
        continue;
      }

      // 增量采集:已采全的直接跳过(不开详情/不进主页)
      if (skipRecordIdSet.has(recordId)) {
        skippedCount += 1;
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'skipped',
          record,
          tabId: runnerContext.sourceTabId,
        });
        results.push({
          recordId,
          ok: true,
          reason: 'already_captured',
          message: `${markerLabel} 之前已采过，自动跳过`,
          ...captureTraceFields,
        });
        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_skipped',
            message: `${progressLabel}：之前已采过，跳过（增量采集）`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            skippedCount,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail item skipped');
        }
        activeDetailItemContext = null;
        continue;
      }

      if (!record || !isDetailCaptureRecordType(record.type)) {
        discardPrefetchForRecord(recordId);
        const failure = buildDetailCaptureFailure(
          DETAIL_CAPTURE_FAILURE_CODE.INVALID_RECORD,
          'prepare',
          '记录不存在或类型不支持补采详情',
        );
        await persistAndPublishCaptureTraceState({
          recordId,
          state: 'failed',
          record,
          tabId: runnerContext.sourceTabId,
        });
        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: `${markerLabel}：${failure.userMessage}`,
          diagnosticMessage: failure.diagnosticMessage,
          ...captureTraceFields,
        };
        results.push(result);
        failedCount += 1;

        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_failed',
            message: `${progressLabel}：补采失败，记录无效`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail invalid record');
        }
        activeDetailItemContext = null;
        continue;
      }

      const douyinRecordIdentity =
        inspectDouyinRecordDetailIdentity(record);
      const recordIdentityConflict =
        douyinRecordIdentity.isDouyin &&
        douyinRecordIdentity.conflicting;
      const noteUrl = resolveRecordNoteUrl(record);
      if (!noteUrl) {
        discardPrefetchForRecord(recordId);
        const latestRecord = (await getRecord(recordId)) || record;
        if (recordIdentityConflict) {
          integrityBlocked = true;
        }
        const recordIdentityError = recordIdentityConflict
          ? Object.assign(
              new Error(
                `抖音记录包含冲突作品 ID：${douyinRecordIdentity.noteIds.join('、')}`,
              ),
              {
                code: 'DOUYIN_DETAIL_ID_MISMATCH',
                expectedNoteId: '',
                conflictingNoteIds: douyinRecordIdentity.noteIds,
              },
            )
          : null;
        const failure = recordIdentityConflict
          ? classifyDetailCaptureFailure(recordIdentityError, {
              stage: 'prepare',
            })
          : buildDetailCaptureFailure(
              DETAIL_CAPTURE_FAILURE_CODE.LINK_MISSING,
              'prepare',
              '未找到可访问的笔记链接',
            );
        const failedPayload = applyDetailCapturePatch(
          latestRecord.payload,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.FAILED,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            error: failure.userMessage,
            failureCode: failure.code,
            failureStage: failure.stage,
            failureCategory: failure.category,
            diagnosticMessage: failure.diagnosticMessage,
            noteUrl: '',
          }),
        );
        const failedTraceTransition = transitionRecordCaptureTrace(
          latestRecord,
          failedPayload,
          recordIdentityConflict ? 'integrity_blocked' : 'failed',
        );
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: failedTraceTransition.payload,
        });
        await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
          failedTraceTransition.binding,
        ]);

        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: `${markerLabel}：${failure.userMessage}`,
          diagnosticMessage: failure.diagnosticMessage,
          integrityBlocked: recordIdentityConflict,
          fatal: recordIdentityConflict,
          stopBatch: recordIdentityConflict,
          ...captureTraceFields,
        };
        results.push(result);
        failedCount += 1;

        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_failed',
            message: recordIdentityConflict
              ? `${progressLabel}：记录内作品 ID 冲突，已停止剩余补采`
              : `${progressLabel}：补采失败，缺少笔记链接`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, recordIdentityConflict
            ? 'detail record identity conflict'
            : 'detail missing link');
        }
        activeDetailItemContext = null;
        if (recordIdentityConflict) {
          break;
        }
        continue;
      }

      const recordPlatform = String(
        record?.platform || detectPlatformFromUrl(noteUrl),
      )
        .trim()
        .toLowerCase();
      const expectedDouyinNoteId =
        recordPlatform === 'douyin'
          ? resolveExpectedDouyinCommentNoteId(record, noteUrl)
          : '';

      const startedAt = Date.now();
      activeDetailItemContext = {
        ...activeDetailItemContext,
        noteUrl,
        startedAt,
        activeStage: 'capturing',
      };
      const capturingPayload = applyDetailCapturePatch(
        record.payload,
        createDetailCapturePatch({
          status: DETAIL_CAPTURE_STATUS.CAPTURING,
          startedAt,
          finishedAt: 0,
          error: '',
          failureCode: '',
          failureStage: '',
          failureCategory: '',
          diagnosticMessage: '',
          noteUrl,
        }),
      );
      const capturingTraceTransition = transitionRecordCaptureTrace(
        record,
        capturingPayload,
        'capturing',
      );

      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: capturingTraceTransition.payload,
      });
      activeDetailItemContext = {
        ...activeDetailItemContext,
        captureStarted: true,
        record: {
          ...record,
          payload: capturingTraceTransition.payload,
        },
      };
      await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
        capturingTraceTransition.binding,
      ]);

      if (onProgress) {
        await reportProgressFailSoft(onProgress, {
          phase: 'detail_item_capturing',
          message: `${progressLabel}：已找到作品链接，准备打开详情...`,
          recordId,
          current,
          total: uniqueRecordIds.length,
          noteUrl,
          successCount,
          failedCount,
          filteredCount,
          runnerTabId: runnerContext.runnerTabId,
          ...captureTraceFields,
        }, 'detail item capturing');
      }

      let activeStage = 'navigation';
      activeDetailItemContext.activeStage = activeStage;
      let detailWorkerLease = null;
      let nextPrefetchCandidate = null;
      let nextPrefetchCandidatePromise = null;
      captureCurrentDetail: try {
        const stalePrefetchSlot = detailPrefetchPipeline
          .snapshot()
          .slots.find(
            (slot) =>
              slot.recordId === recordId &&
              slot.url &&
              slot.url !== noteUrl &&
              slot.state !== 'collecting',
          );
        if (stalePrefetchSlot) {
          detailPrefetchPipeline.discard({
            recordId,
            url: stalePrefetchSlot.url,
          });
        }
        if (
          runnerContexts.length > 1 &&
          !securityBlocked &&
          !shouldStopDetailBatch()
        ) {
          nextPrefetchCandidatePromise = findNextDetailPrefetchCandidate({
            recordIds: uniqueRecordIds,
            startIndex: index + 1,
            skipRecordIdSet: preDetailSkipRecordIdSet,
          }).catch((error) => {
            console.warn(
              '[CaptureSync] resolve next detail prefetch candidate failed (ignored):',
              error?.message || error,
            );
            return null;
          });
        }
        detailWorkerLease = await detailPrefetchPipeline.acquire({
          recordId,
          url: noteUrl,
        });
        runnerContext =
          runnerContexts.find(
            (context) => context.runnerTabId === detailWorkerLease.tabId,
          ) || runnerContext;
        activeDetailItemContext.runnerTabId = runnerContext.runnerTabId;
        const workerSnapshot = detailPrefetchPipeline.snapshot();
        await reportProgressFailSoft(onProgress, {
          phase: 'detail_worker_promoted',
          message: detailWorkerLease.prefetched
            ? `${detailWorkerLease.label} 已加载完成，开始采集 ${progressLabel}`
            : `${detailWorkerLease.label} 正在采集 ${progressLabel}`,
          recordId,
          current,
          total: uniqueRecordIds.length,
          runnerTabId: runnerContext.runnerTabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: runnerContext.runnerTabId,
          workerMode: workerSnapshot.mode,
          workerRevision: workerSnapshot.revision,
          workerStates: workerSnapshot.slots,
          ...captureTraceFields,
        }, 'detail worker promoted');

        // 真正的 A/B ping-pong：当前页一取得唯一 COLLECTING lease，另一页就
        // 立即排队加载下一条。standby 只导航与做安全探测，不读取正文/主页/评论；
        // 下一轮仍须等当前 lease 释放后才能晋升为 COLLECTING。
        nextPrefetchCandidate = nextPrefetchCandidatePromise
          ? await nextPrefetchCandidatePromise
          : null;
        if (
          nextPrefetchCandidate &&
          !securityBlocked &&
          !shouldStopDetailBatch()
        ) {
          const prefetchResult = detailPrefetchPipeline.prefetch(
            nextPrefetchCandidate,
            {excludeTabId: detailWorkerLease.tabId},
          );
          if (prefetchResult.started || prefetchResult.reused) {
            const prefetchSnapshot = detailPrefetchPipeline.snapshot();
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_item_prefetch_queued',
              message: `${detailWorkerLease.label} 正在采集当前条；另一工作页已排队预加载下一条`,
              recordId,
              nextRecordId: nextPrefetchCandidate.recordId,
              current,
              total: uniqueRecordIds.length,
              runnerTabId: runnerContext.runnerTabId,
              runnerTabIds: runnerContexts.map(
                (context) => context.runnerTabId,
              ),
              activeRunnerTabId: runnerContext.runnerTabId,
              prefetchRunnerTabId: prefetchResult.tabId,
              workerMode: prefetchSnapshot.mode,
              workerRevision: prefetchSnapshot.revision,
              workerStates: prefetchSnapshot.slots,
              ...captureTraceFields,
            }, 'detail prefetch queued');
          }
        }

        const remainingHydrationWaitMs = Math.max(
          0,
          normalizedDetailAfterNavWaitMs -
            Math.max(0, Date.now() - Number(detailWorkerLease.readyAt || 0)),
        );
        await waitMsWithStop(
          remainingHydrationWaitMs,
          shouldStopDetailBatch,
          'DETAIL_CAPTURE_CANCELED',
        );

        if (shouldStopDetailBatch()) {
          throw new Error('DETAIL_CAPTURE_CANCELED');
        }

        const resolvedEnableLowFollowerHitFilter =
          enableLowFollowerHitFilter ??
          settings.enableLowFollowerHitFilterOnDetailCapture ??
          settings.enableLowFollowerHitFilter;
        const resolvedLowFollowerHitThreshold =
          lowFollowerHitThreshold ??
          settings.lowFollowerHitThresholdOnDetailCapture ??
          settings.lowFollowerHitThreshold;
        const shouldApplyLowFollowerHitFilter = Boolean(
          resolvedEnableLowFollowerHitFilter &&
            record.type === SYNC_TYPE.KEYWORD_NOTES,
        );
        const shouldCaptureBloggerMetricsForRecord =
          includeBloggerMetrics || shouldApplyLowFollowerHitFilter;

        activeStage = 'note_capture';
        activeDetailItemContext.activeStage = activeStage;
        const noteCaptureWorkerSnapshot = detailPrefetchPipeline.snapshot();
        await reportProgressFailSoft(onProgress, {
          phase: 'detail_note_capture_started',
          message:
            runnerContexts.length > 1
              ? `${progressLabel}：正在读取当前笔记；另一工作页并行预加载下一条`
              : `${progressLabel}：正在读取当前笔记`,
          recordId,
          current,
          total: uniqueRecordIds.length,
          runnerTabId: runnerContext.runnerTabId,
          runnerTabIds: runnerContexts.map((context) => context.runnerTabId),
          activeRunnerTabId: runnerContext.runnerTabId,
          workerMode: noteCaptureWorkerSnapshot.mode,
          workerRevision: noteCaptureWorkerSnapshot.revision,
          workerStates: noteCaptureWorkerSnapshot.slots,
          ...captureTraceFields,
        }, 'detail note capture started');
        const captureCurrentNotePayload = async () =>
          await captureInTab(runnerContext.runnerTabId, {
            mode: 'single',
            captureParams: {
              expectedNoteId: expectedDouyinNoteId,
              // 正文/媒体/作品身份是核心事务。博主指标会在核心结果通过
              // 身份校验后按需补采，不能让可选指标拖垮或推翻正文采集。
              includeBloggerMetrics: false,
              preferWorksTabForBloggerMetrics: false,
            },
          });
        let noteResult = await captureCurrentNotePayload();

        const isRecoverableDouyinExtractorFailure = (result) => {
          if (result?.ok === true || isCaptureCanceledResult(result)) {
            return false;
          }
          if (isDetailSecurityBlockError(result?.error)) {
            return false;
          }
          const code = String(result?.error?.code || '')
            .trim()
            .toUpperCase();
          return (
            code === 'DOUYIN_DETAIL_NOT_READY' ||
            code === 'DOUYIN_CONTENT_UNAVAILABLE'
          );
        };
        if (
          recordPlatform === 'douyin' &&
          isRecoverableDouyinExtractorFailure(noteResult)
        ) {
          const recordKey = String(recordId);
          const readyEntryUrl =
            douyinReadyEntryUrlByRecordId.get(recordKey) || '';
          const fallbackCandidates = buildDouyinDetailNavigationCandidates(
            noteUrl,
            douyinSearchModalUrlByRecordId.get(recordKey) || '',
            douyinDetailPathByRecordId.get(recordKey) || 'unknown',
          );
          const readyEntryIndex = fallbackCandidates.indexOf(readyEntryUrl);
          const remainingCandidates =
            readyEntryIndex >= 0
              ? fallbackCandidates.slice(readyEntryIndex + 1)
              : [];
          const fallbackDeadline =
            Date.now() +
            Math.min(
              normalizedDetailNavTimeoutMs,
              DOUYIN_DETAIL_NAV_TOTAL_TIMEOUT_MS,
            );

          for (const candidateUrl of remainingCandidates) {
            const remainingBudgetMs = Math.max(
              0,
              fallbackDeadline - Date.now(),
            );
            if (remainingBudgetMs <= 0) break;
            try {
              await detailPrefetchPipeline.runExternalNavigation(async () => {
                await openUrlInTab(
                  runnerContext.runnerTabId,
                  candidateUrl,
                  {
                    timeoutMs: Math.min(
                      remainingBudgetMs,
                      DOUYIN_DETAIL_NAV_CANDIDATE_TIMEOUT_MS,
                    ),
                    shouldStop: shouldStopDetailBatch,
                    active: true,
                  },
                );
                return await probeDouyinNavigationEntry(
                  runnerContext.runnerTabId,
                  {
                    targetUrl: candidateUrl,
                    shouldStop: shouldStopDetailBatch,
                    timeoutMs: Math.min(
                      DOUYIN_DETAIL_READY_PROBE_TIMEOUT_MS,
                      Math.max(1000, fallbackDeadline - Date.now()),
                    ),
                  },
                );
              });
              douyinReadyEntryUrlByRecordId.set(recordKey, candidateUrl);
              noteResult = await captureCurrentNotePayload();
            } catch (error) {
              if (
                isDetailSecurityBlockError(error) ||
                isDouyinIdentityIntegrityError(error) ||
                String(error?.message || '') === 'DETAIL_CAPTURE_CANCELED'
              ) {
                throw error;
              }
              const code = String(error?.code || '')
                .trim()
                .toUpperCase();
              if (
                code !== 'DETAIL_NAVIGATION_TIMEOUT' &&
                code !== 'DOUYIN_DETAIL_NOT_READY' &&
                code !== 'DOUYIN_CONTENT_UNAVAILABLE'
              ) {
                throw error;
              }
              noteResult = {
                ok: false,
                error: {
                  code,
                  message: error?.message || '抖音详情页未完成加载',
                },
              };
            }

            if (
              noteResult?.ok === true ||
              !isRecoverableDouyinExtractorFailure(noteResult)
            ) {
              break;
            }
          }
        }

        throwIfDetailPrefetchFatal();

        if (!noteResult?.ok) {
          if (isCaptureCanceledResult(noteResult)) {
            throw new Error('DETAIL_CAPTURE_CANCELED');
          }
          if (noteResult?.error?.code === 'XHS_SECURITY_BLOCK') {
            securityBlocked = true; // 撞风控,下面 catch 会停整批
          }
          const noteCaptureError = new Error(
            noteResult?.error?.message || '详情采集失败',
          );
          if (
            noteResult?.error &&
            typeof noteResult.error === 'object'
          ) {
            Object.assign(noteCaptureError, noteResult.error);
          }
          noteCaptureError.code = String(noteResult?.error?.code || '').trim();
          throw noteCaptureError;
        }

        const previouslySavedCommentItems = Array.isArray(
          record.payload?.detailPayload?.commentsCleanedItems,
        )
          ? record.payload.detailPayload.commentsCleanedItems
          : [];
        let detailPayload = applyCommentStatusToPayload(
          noteResult.data,
          createCommentStatusPatch({
            status: COMMENT_CAPTURE_STATUS.NOT_STARTED,
            startedAt: 0,
            finishedAt: 0,
            stoppedByUser: false,
            error: '',
            cleanedItems: previouslySavedCommentItems,
            mergedText: buildCommentsMergedText(
              previouslySavedCommentItems,
            ),
          }),
        );

        // 防串号:抖音失效作品会倒计时跳去推荐内容。目标 ID、采集结果 ID
        // 必须形成唯一闭环；缺失、多 ID 或错 ID 均 fail closed，禁止写回。
        if (recordPlatform === 'douyin') {
          if (
            !expectedDouyinNoteId ||
            resolveVerifiedDouyinDetailNoteId(
              detailPayload,
              expectedDouyinNoteId,
            ) !== expectedDouyinNoteId
          ) {
            throw buildDouyinDetailIdentityError(
              expectedDouyinNoteId,
              detailPayload,
            );
          }
        }
        detailPayload = ensureBloggerMetricsFields(detailPayload);

        let stopAfterCurrent = false;
        if (shouldCaptureBloggerMetricsForRecord) {
          activeStage = 'blogger_metrics_capture';
          activeDetailItemContext.activeStage = activeStage;
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_blogger_metrics_capturing',
              message: `${progressLabel}：正在采集博主指标...`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              includeBloggerMetrics: true,
              runnerTabId: runnerContext.runnerTabId,
              ...captureTraceFields,
            }, 'detail blogger metrics');
          }

          const metricsResult = await captureBloggerMetricsForDetailPayload(
            detailPayload,
            {
              tabId: runnerContext.runnerTabId,
              noteUrl,
              detailNavTimeoutMs: normalizedDetailNavTimeoutMs,
              profileAfterNavWaitMs: normalizedProfileAfterNavWaitMs,
              shouldStop: shouldStopDetailBatch,
              cache: bloggerMetricsCache,
              // 小红书:指标缺时进主页(原语义不变)。抖音走上方独立的
              // 作品页指标补采，不进入小红书的主页/缓存语义。
              allowProfileNavigation: recordPlatform !== 'douyin',
              // 抖音专用:仅为补「抖音号(douyinId)」多进一次主页,与指标早返回解耦。
              // 真号只在博主主页正文,作品页/详情页拿不到 → 单独 fail-soft 取号。
              // 受总开关 ENABLE_DOUYIN_ID_LOOKUP_ON_BATCH 控制:当前关闭=不进主页(回退原行为)。
              allowDouyinIdLookup:
                ENABLE_DOUYIN_ID_LOOKUP_ON_BATCH && recordPlatform === 'douyin',
              expectedNoteId: expectedDouyinNoteId,
              preferWorksTabForBloggerMetrics:
                recordPlatform === 'douyin' &&
                isDouyinContentFlowUrl(
                  douyinReadyEntryUrlByRecordId.get(String(recordId)) ||
                    noteUrl,
                ),
              navigate: async (
                navigationTabId,
                navigationUrl,
                navigationOptions = {},
              ) =>
                await detailPrefetchPipeline.runExternalNavigation(async () => {
                  await openUrlInTab(navigationTabId, navigationUrl, {
                    ...navigationOptions,
                    shouldStop: shouldStopDetailBatch,
                    // 小红书 A/B 工作页始终留在后台。主页指标补采及回到笔记页
                    // 不应把用户从搜索来源页切走；可靠加载仍由导航轮询和
                    // 持久任务持有的工作页生命周期保证。
                    ...(recordPlatform === 'xiaohongshu'
                      ? {active: false}
                      : {}),
                  });
                  await probeDetailPreloadSafety(navigationTabId);
                }),
            },
          );
          const metricsNavigationFatalError =
            detailPrefetchPipeline.getFatalError();
          if (metricsNavigationFatalError) {
            securityBlocked = true;
            throw metricsNavigationFatalError;
          }
          detailPayload = applyBloggerMetricsResultToPayload(
            detailPayload,
            metricsResult,
          );

          if (metricsResult.canceled) {
            if (shouldApplyLowFollowerHitFilter) {
              const canceledError = new Error('DETAIL_CAPTURE_CANCELED');
              throw attachPartialDetailPayload(canceledError, detailPayload);
            }
            stopAfterCurrent = true;
          }
        }

        throwIfDetailPrefetchFatal();

        if (shouldApplyLowFollowerHitFilter && !stopAfterCurrent) {
          const followerCount = resolveProvenBloggerFollowersCount(
            detailPayload,
          );
          if (followerCount === null) {
            const followerProofError = new Error(
              detailPayload.bloggerMetricsCaptureError ||
                '低粉丝筛选无法确认博主粉丝数，请稍后重试',
            );
            followerProofError.code =
              DETAIL_CAPTURE_FAILURE_CODE.BLOGGER_METRICS_FAILED;
            followerProofError.retryable = true;
            throw attachPartialDetailPayload(
              followerProofError,
              detailPayload,
            );
          }
          if (followerCount > Number(resolvedLowFollowerHitThreshold)) {
            const filteredBinding = buildCaptureTraceBinding(
              bindCaptureTrace(
                resolveCaptureTraceFromRecord(record),
                recordId,
                'filtered',
              ),
            );
            await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
              filteredBinding,
            ]);
            const { deleteRecord } = await import('./storage.js');
            await deleteRecord(recordId);
            filteredCount += 1;
            results.push({
              recordId,
              ok: true,
              filtered: true,
              reason: 'low_follower_filtered',
              message: `${markerLabel} 已过滤：粉丝数 ${followerCount} 超过阈值 ${resolvedLowFollowerHitThreshold}`,
              ...captureTraceFields,
            });
            if (onProgress) {
              await reportProgressFailSoft(onProgress, {
                phase: 'detail_item_filtered',
                message: `${progressLabel}：已过滤，粉丝数 ${followerCount} 超过阈值 ${resolvedLowFollowerHitThreshold}`,
                recordId,
                current,
                total: uniqueRecordIds.length,
                successCount,
                failedCount,
                filteredCount,
                runnerTabId: runnerContext.runnerTabId,
                ...captureTraceFields,
              }, 'detail low follower filtered');
            }
            activeDetailItemContext = null;
            break captureCurrentDetail;
          }
        }

        const detailKeywordFilterResult = evaluateDetailKeywordFilter(
          record,
          detailPayload,
        );
        if (detailKeywordFilterResult.keywords.length > 0) {
          detailKeywordFilterEnabled = true;
        }
        if (!detailKeywordFilterResult.matched && !stopAfterCurrent) {
          const filteredBinding = buildCaptureTraceBinding(
            bindCaptureTrace(
              resolveCaptureTraceFromRecord(record),
              recordId,
              'filtered',
            ),
          );
          await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
            filteredBinding,
          ]);
          await deleteRecord(recordId);
          filteredCount += 1;
          detailKeywordFilteredCount += 1;
          results.push({
            recordId,
            ok: true,
            filtered: true,
            reason: 'detail_keyword_filtered',
            message: `${markerLabel} 已过滤：未命中主题关键词「${formatDetailKeywordFilterLabel(detailKeywordFilterResult.keywords)}」`,
            ...captureTraceFields,
          });
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_item_filtered',
              message: `${progressLabel}：已过滤，未命中主题关键词「${formatDetailKeywordFilterLabel(detailKeywordFilterResult.keywords)}」`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              runnerTabId: runnerContext.runnerTabId,
              ...captureTraceFields,
            }, 'detail keyword filtered');
          }
          activeDetailItemContext = null;
          break captureCurrentDetail;
        }

        const knownCommentsCount = includeComments
          ? resolveKnownCommentsCountForDetailCapture(record, detailPayload)
          : null;
        const shouldSkipConfirmedEmptyComments =
          includeComments && knownCommentsCount === 0;
        if (shouldSkipConfirmedEmptyComments && !stopAfterCurrent) {
          const confirmedAt = Date.now();
          detailPayload = {
            ...applyCommentStatusToPayload(
              detailPayload,
              createCommentStatusPatch({
                status: COMMENT_CAPTURE_STATUS.DONE,
                startedAt: confirmedAt,
                finishedAt: confirmedAt,
                stoppedByUser: false,
                error: '',
                cleanedItems: [],
                mergedText: '',
              }),
            ),
            commentsCaptureSkipReason: 'confirmed_zero',
          };
          detailPayload = applyCommentLeadsToPayload({
            syncType: SYNC_TYPE.SINGLE_NOTE,
            payload: detailPayload,
            commentLeadsConfig,
            computedAt: confirmedAt,
          }).payload;
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_comments_skipped_empty',
            message: `${progressLabel}：已确认评论数为 0，跳过评论区并进入下一条`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            includeComments: true,
            commentsCount: 0,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail comments confirmed empty');
        }

        if (
          includeComments &&
          !stopAfterCurrent &&
          !shouldSkipConfirmedEmptyComments
        ) {
          activeStage = 'comments_capture';
          const expectedCommentNoteId =
            recordPlatform === 'douyin'
              ? expectedDouyinNoteId
              : '';
          const verifiedCommentNoteId =
            recordPlatform === 'douyin'
              ? resolveVerifiedDouyinDetailNoteId(
                  detailPayload,
                  expectedCommentNoteId,
                )
              : '';
          if (recordPlatform === 'douyin') {
            try {
              const readyResult =
                await ensureDouyinCommentTargetReadyInTab({
                  tabId: runnerContext.runnerTabId,
                  record,
                  targetUrl: noteUrl,
                  verifiedNoteId: verifiedCommentNoteId,
                  sourcePageUrl:
                    douyinSearchModalUrlByRecordId.get(String(recordId)) ||
                    '',
                  shouldStop: shouldStopDetailBatch,
                  navigateCandidate: async (operation) =>
                    await detailPrefetchPipeline.runExternalNavigation(
                      operation,
                    ),
                  onRecovery: async () => {
                    await reportProgressFailSoft(onProgress, {
                      phase: 'detail_comments_target_recovering',
                      message: `${progressLabel}：正在重新确认目标作品后采集评论`,
                      recordId,
                      current,
                      total: uniqueRecordIds.length,
                      runnerTabId: runnerContext.runnerTabId,
                      ...captureTraceFields,
                    }, 'detail comments target recovering');
                  },
                });
              void recordDiagnosticStage({
                stageKey: 'capture.douyin_comment_identity',
                label: '抖音评论目标确认',
                status: 'completed',
                metrics: {
                  recordId: String(recordId || ''),
                  expectedNoteId: String(expectedCommentNoteId || ''),
                  recovered: readyResult?.recovered === true,
                },
                taskContext: getActiveTaskContext(),
                featureKey: 'capture.enhancement',
                parentFeatureKey: 'capture.enhancement',
                source: 'capture-sync',
              }).catch(() => null);
            } catch (error) {
              throw attachPartialDetailPayload(error, detailPayload);
            }
          }
          let commentCaptureIdentity;
          try {
            commentCaptureIdentity = await ensureCommentCaptureIdentity({
              runnerTabId: runnerContext.runnerTabId,
            });
          } catch (error) {
            throw attachPartialDetailPayload(error, detailPayload);
          }
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_comments_capturing',
              message: `${progressLabel}：正在采集评论...`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              includeComments: true,
              commentsMaxDetectedItems: normalizedCommentsMaxDetectedItems,
              captureRequestId: commentCaptureIdentity.captureRequestId,
              runnerTabId: commentCaptureIdentity.runnerTabId,
              captureAction: 'captureComments',
            });
          }

          const existingCommentItems = Array.isArray(
            previouslySavedCommentItems,
          )
            ? previouslySavedCommentItems
            : [];
          let commentsResult;
          try {
            commentsResult = await captureCommentsForCurrentNote({
              tabId: commentCaptureIdentity.runnerTabId,
              captureRequestId: commentCaptureIdentity.captureRequestId,
              recordId,
              current,
              total: uniqueRecordIds.length,
              existingItems: existingCommentItems,
              maxDetectedItems: normalizedCommentsMaxDetectedItems,
              maxDurationMs: settings.sharedMaxDurationMs,
              waitMinMs: settings.sharedWaitMinMs,
              waitMaxMs: settings.sharedWaitMaxMs,
              stallTimeoutMs: settings.sharedStallTimeoutMs,
              expectedNoteId: expectedCommentNoteId,
              verifiedNoteId: verifiedCommentNoteId,
            });
          } catch (error) {
            throw attachPartialDetailPayload(error, detailPayload);
          }
          const commentIdentityFailure =
            commentsResult.status !== COMMENT_CAPTURE_STATUS.FAILED ||
            commentsResult.errorCode === 'DOUYIN_COMMENT_ID_MISMATCH'
              ? buildDouyinCommentIdentityFailure(
                  expectedCommentNoteId,
                  resolveCapturedDouyinCommentNoteId(commentsResult),
                )
              : null;
          if (commentIdentityFailure) {
            const error = new Error(commentIdentityFailure.message);
            error.code = commentIdentityFailure.code;
            throw attachPartialDetailPayload(error, detailPayload);
          }
          detailPayload = applyCommentResultToSingleNotePayload(
            detailPayload,
            commentsResult,
          );
          detailPayload = applyCommentLeadsToPayload({
            syncType: SYNC_TYPE.SINGLE_NOTE,
            payload: detailPayload,
            commentLeadsConfig,
            computedAt: Date.now(),
          }).payload;

          if (commentsResult.status === COMMENT_CAPTURE_STATUS.PARTIAL) {
            const partialError =
              commentsResult.stoppedByUser && shouldStopDetailBatch()
                ? new Error('DETAIL_CAPTURE_CANCELED')
                : new Error(
                    String(
                      commentsResult.error ||
                        '评论采集尚未完成，已保留当前结果；下次将继续采集',
                    ).trim(),
                  );
            if (
              String(partialError.message || '') !==
              'DETAIL_CAPTURE_CANCELED'
            ) {
              partialError.code =
                DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED;
            }
            partialError.partialDetailPayload = detailPayload;
            throw partialError;
          }

          if (
            commentsResult.status === COMMENT_CAPTURE_STATUS.FAILED &&
            commentsResult.stoppedByUser !== true
          ) {
            const commentsError = new Error(
              String(
                commentsResult?.errorMessage ||
                  commentsResult?.error?.message ||
                  commentsResult?.error ||
                  '评论采集失败，请稍后重试',
              ).trim(),
            );
            commentsError.code =
              DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED;
            // 正文已经采到，评论失败时保留当前详情快照。第二次仍失败，
            // 卡片应明确显示“正文已采到、评论失败”，不能退回“未增强”。
            commentsError.partialDetailPayload = detailPayload;
            throw commentsError;
          }

          if (
            commentsResult.stoppedByUser &&
            shouldStopDetailBatch()
          ) {
            stopAfterCurrent = true;
          }
        }

        throwIfDetailPrefetchFatal();

        activeStage = 'commit_guard';
        activeDetailItemContext.activeStage = activeStage;
        if (recordPlatform === 'douyin') {
          if (
            !expectedDouyinNoteId ||
            resolveVerifiedDouyinDetailNoteId(
              detailPayload,
              expectedDouyinNoteId,
            ) !== expectedDouyinNoteId
          ) {
            throw buildDouyinDetailIdentityError(
              expectedDouyinNoteId,
              detailPayload,
            );
          }
          try {
            const finalReady = await probeDouyinTargetRouteSafety(
              runnerContext.runnerTabId,
              {
                targetUrl: noteUrl,
                verifiedNoteId: expectedDouyinNoteId,
                requireVerifiedNoteId: true,
                shouldStop: shouldStopDetailBatch,
                timeoutMs: DOUYIN_COMMENT_RECOVERY_READY_TIMEOUT_MS,
              },
            );
            if (
              extractDouyinDetailGuardItemId(finalReady?.currentNoteId) !==
              expectedDouyinNoteId
            ) {
              throw buildDouyinDetailIdentityError(
                expectedDouyinNoteId,
                {
                  noteId: finalReady?.currentNoteId,
                  url: finalReady?.currentUrl,
                },
              );
            }
            void recordDiagnosticStage({
              stageKey: 'capture.douyin_commit_guard',
              label: '抖音写入前身份确认',
              status: 'completed',
              metrics: {
                recordId: String(recordId || ''),
                expectedNoteId: String(expectedDouyinNoteId || ''),
                currentNoteId: String(finalReady?.currentNoteId || ''),
                routeKind: String(finalReady?.routeKind || ''),
                visibleDetailBound:
                  finalReady?.hasBoundDetailRoot === true,
              },
              taskContext: getActiveTaskContext(),
              featureKey: 'capture.enhancement',
              parentFeatureKey: 'capture.enhancement',
              source: 'capture-sync',
            }).catch(() => null);
          } catch (error) {
            const observedCurrentNoteId =
              extractDouyinDetailGuardItemId(error?.currentNoteId) ||
              extractDouyinDetailGuardItemId(error?.currentUrl);
            const conflictingNoteId = Array.isArray(error?.conflictingNoteIds)
              ? error.conflictingNoteIds
                  .map(extractDouyinDetailGuardItemId)
                  .find(
                    (noteId) =>
                      noteId && noteId !== expectedDouyinNoteId,
                  )
              : '';
            if (
              error?.activeWorkIdentityConflict === true ||
              (observedCurrentNoteId &&
                observedCurrentNoteId !== expectedDouyinNoteId)
            ) {
              throw attachPartialDetailPayload(
                buildDouyinDetailIdentityError(
                  expectedDouyinNoteId,
                  {
                    noteId:
                      conflictingNoteId ||
                      observedCurrentNoteId,
                    url: error?.currentUrl,
                  },
                ),
                detailPayload,
              );
            }
            throw attachPartialDetailPayload(error, detailPayload);
          }
        }

        const latestRecord = (await getRecord(recordId)) || record;
        detailPayload = sanitizeMediaFieldsForStorage(
          normalizeDetailPayloadAgainstRecord(latestRecord, detailPayload),
        );
        const nextPayloadBase = { ...latestRecord.payload };
        const nextCommentBaseline = includeComments
          ? resolveRecordListCommentsCount(latestRecord) ??
            resolveRecordListCommentsCount(record) ??
            normalizeOptionalCount(detailPayload.comments)
          : null;
        if (nextCommentBaseline !== null) {
          nextPayloadBase.detailCommentCountBaseline = nextCommentBaseline;
        }
        const mergedPayload = applyDetailCapturePatch(
          nextPayloadBase,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.DONE,
            startedAt,
            finishedAt: Date.now(),
            error: '',
            failureCode: '',
            failureStage: '',
            failureCategory: '',
            diagnosticMessage: '',
            noteUrl,
            detailPayload,
          }),
        );
        const doneTraceTransition = transitionRecordCaptureTrace(
          latestRecord,
          mergedPayload,
          stopAfterCurrent ? 'cancelled' : 'done',
        );

        const preview = buildDetailCapturePreview(record, detailPayload);
        const latePrefetchFatalError = detailPrefetchPipeline.getFatalError();
        if (latePrefetchFatalError) {
          securityBlocked = true;
          throw latePrefetchFatalError;
        }
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: doneTraceTransition.payload,
          title: preview.title,
          summary: preview.summary,
        });
        await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
          doneTraceTransition.binding,
        ]);

        const result = {
          recordId,
          ok: true,
          reason: 'none',
          message: `${markerLabel} 详情补采成功`,
          ...captureTraceFields,
        };
        results.push(result);
        successCount += 1;

        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: 'detail_item_done',
            message: `${progressLabel}：详情补采成功`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail item done');
        }

        activeDetailItemContext = null;

        if (stopAfterCurrent) {
          canceled = true;
          break;
        }
      } catch (error) {
        const pipelineFatalError = detailPrefetchPipeline.getFatalError();
        if (pipelineFatalError || isDetailSecurityBlockError(error)) {
          securityBlocked = true;
        }
        const effectiveError = pipelineFatalError || error;
        if (isDouyinIdentityIntegrityError(effectiveError)) {
          integrityBlocked = true;
        }
        const canceledByUser =
          !pipelineFatalError && isDetailCaptureCanceledError(effectiveError);
        if (canceledByUser) {
          canceled = true;
        }
        const failure = classifyDetailCaptureFailure(effectiveError, {
          stage: activeStage,
        });
        const runnerContextInterrupted = Boolean(
          runnerContext?.ownsRunnerTab &&
            failure.code === DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED,
        );
        if (runnerContextInterrupted) {
          if (detailWorkerLease) {
            detailPrefetchPipeline.release(detailWorkerLease);
            detailWorkerLease = null;
          }
          const recovered = await recreateInterruptedDetailRunners({
            recordId,
            recordPlatform,
            expectedNoteId: expectedDouyinNoteId,
            current,
            total: uniqueRecordIds.length,
          });
          if (recovered) {
            activeDetailItemContext = null;
            index -= 1;
            continue;
          }
          runnerInterrupted = true;
        }
        const terminalTraceState = canceledByUser
          ? 'cancelled'
          : securityBlocked
            ? 'security_blocked'
            : integrityBlocked
              ? 'integrity_blocked'
            : runnerContextInterrupted
              ? 'runner_interrupted'
              : 'failed';

        const latestRecord = (await getRecord(recordId)) || record;
        const failedPayload = applyDetailCapturePatch(
          latestRecord.payload,
          createDetailCapturePatch({
            status: DETAIL_CAPTURE_STATUS.FAILED,
            startedAt,
            finishedAt: Date.now(),
            error: failure.userMessage,
            failureCode: failure.code,
            failureStage: failure.stage,
            failureCategory: failure.category,
            diagnosticMessage: failure.diagnosticMessage,
            noteUrl,
            detailPayload:
              effectiveError?.partialDetailPayload !== undefined
                ? sanitizeMediaFieldsForStorage(
                    normalizeDetailPayloadAgainstRecord(
                      latestRecord,
                      effectiveError.partialDetailPayload,
                    ),
                  )
                : undefined,
          }),
        );
        const failedTraceTransition = transitionRecordCaptureTrace(
          latestRecord,
          failedPayload,
          terminalTraceState,
        );
        await updateRecord(recordId, {
          status: RECORD_STATUS.DRAFT,
          payload: failedTraceTransition.payload,
        });
        await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
          failedTraceTransition.binding,
        ]);

        const result = {
          recordId,
          ok: false,
          reason: failure.code,
          category: failure.category,
          stage: failure.stage,
          message: `${markerLabel}：${failure.userMessage}`,
          diagnosticMessage: failure.diagnosticMessage,
          canceled: canceledByUser,
          securityBlocked,
          integrityBlocked,
          fatal: integrityBlocked,
          stopBatch: integrityBlocked,
          runnerInterrupted: runnerContextInterrupted,
          recoveryRequired: runnerContextInterrupted,
          retryable: effectiveError?.retryable === true,
          ...captureTraceFields,
        };
        results.push(result);
        if (!canceledByUser) {
          failedCount += 1;
        }

        if (onProgress) {
          await reportProgressFailSoft(onProgress, {
            phase: canceledByUser
              ? 'detail_item_cancelled'
              : 'detail_item_failed',
            message: runnerContextInterrupted
              ? `处理 ${markerLabel} 时详情采集工作页已关闭或中断，本批停止（已处理 ${results.length}/${uniqueRecordIds.length} 条）`
              : canceledByUser
                ? `${progressLabel}：补采已中止（已处理 ${results.length}/${uniqueRecordIds.length} 条）`
                : `${progressLabel}：补采失败，${failure.userMessage}`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, canceledByUser ? 'detail item cancelled' : 'detail item failed');
        }

        if (securityBlocked) {
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_security_blocked',
              message: `⚠️ ${markerLabel} 触发平台安全限制（访问频繁或验证页），已暂停补采。建议隔较长时间后再跑。`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              runnerTabId: runnerContext.runnerTabId,
              ...captureTraceFields,
            }, 'detail security blocked');
          }
          activeDetailItemContext = null;
          break;
        }
        if (integrityBlocked) {
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_integrity_blocked',
              message: `⚠️ ${markerLabel} 未能确认目标作品身份，已停止剩余补采，且未写入未验证数据。`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              runnerTabId: runnerContext.runnerTabId,
              ...captureTraceFields,
            }, 'detail identity integrity blocked');
          }
          activeDetailItemContext = null;
          break;
        }
        if (runnerInterrupted) {
          if (onProgress) {
            await reportProgressFailSoft(onProgress, {
              phase: 'detail_runner_interrupted',
              message: `处理 ${markerLabel} 时详情采集工作页已关闭或中断，已停止剩余详情采集`,
              recordId,
              current,
              total: uniqueRecordIds.length,
              successCount,
              failedCount,
              filteredCount,
              runnerTabId: runnerContext.runnerTabId,
              sourceTabId: runnerContext.sourceTabId,
              runnerRole: 'detail_worker',
              ...captureTraceFields,
            }, 'detail runner interrupted');
          }
          activeDetailItemContext = null;
          break;
        }
        if (canceledByUser) {
          activeDetailItemContext = null;
          break;
        }
        activeDetailItemContext = null;
      } finally {
        if (detailWorkerLease) {
          detailPrefetchPipeline.release(detailWorkerLease);
        }
      }

      // 条与条之间的随机间隔(防风控);最后一条 / 取消 / 风控时不等。
      if (
        index < uniqueRecordIds.length - 1 &&
        !securityBlocked &&
        !runnerInterrupted &&
        !canceled &&
        !shouldStopDetailBatch()
      ) {
        const itemDelay =
          DETAIL_ITEM_DELAY_MIN_MS +
          Math.random() * (DETAIL_ITEM_DELAY_MAX_MS - DETAIL_ITEM_DELAY_MIN_MS);
        await activateTabForReliableTimer(waitForegroundTabId);
        const reportDetailDelayProgress = (remainingMs = itemDelay) => {
          if (!onProgress) {
            return;
          }
          const seconds = Math.ceil(Math.max(0, Number(remainingMs) || 0) / 1000);
          void reportProgressFailSoft(onProgress, {
            phase: 'detail_item_delay',
            message: `${progressLabel}：详情处理完成，${seconds} 秒后补采下一条...`,
            recordId,
            current,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            remainingMs,
            runnerTabId: runnerContext.runnerTabId,
            ...captureTraceFields,
          }, 'detail item delay');
        };
        reportDetailDelayProgress(itemDelay);
        try {
          await waitMsWithStopAndTick(itemDelay, shouldStopDetailBatch, {
            errorMessage: 'DETAIL_CAPTURE_CANCELED',
            tickMs: 1000,
            onTick: reportDetailDelayProgress,
          });
        } catch (delayError) {
          const delayFatalError = detailPrefetchPipeline.getFatalError();
          if (delayFatalError) {
            securityBlocked = true;
            throw delayFatalError;
          }
          if (isDetailCaptureCanceledError(delayError)) {
            canceled = true;
            break;
          }
          throw delayError;
        }
      }
    }
  } catch (error) {
    const pipelineFatalError = detailPrefetchPipeline?.getFatalError() || null;
    if (pipelineFatalError || isDetailSecurityBlockError(error)) {
      securityBlocked = true;
    }
    const effectiveError = pipelineFatalError || error;
    if (isDouyinIdentityIntegrityError(effectiveError)) {
      integrityBlocked = true;
    }
    let stopRequested = false;
    if (!pipelineFatalError && typeof shouldStop === 'function') {
      try {
        stopRequested = Boolean(shouldStop());
      } catch (stopError) {
        console.warn(
          '[CaptureSync] detail stop predicate failed (ignored):',
          stopError?.message || stopError,
        );
      }
    }
    const canceledByUser =
      !pipelineFatalError &&
      (isDetailCaptureCanceledError(effectiveError) || stopRequested);
    batchUnexpectedError =
      canceledByUser || securityBlocked || integrityBlocked
        ? null
        : effectiveError;
    if (canceledByUser) {
      canceled = true;
    }

    const context = activeDetailItemContext;
    if (context?.recordId) {
      try {
        let latestRecord = context.record;
        try {
          latestRecord =
            (await getRecord(context.recordId)) || context.record;
        } catch (readError) {
          console.warn(
            '[CaptureSync] detail terminal record read failed (using snapshot):',
            readError?.message || readError,
          );
        }
        const latestTrace = resolveCaptureTraceFromRecord(latestRecord);
        const detailStatus = String(
          latestRecord?.payload?.detailCaptureStatus || '',
        )
          .trim()
          .toLowerCase();
        const traceState = String(latestTrace?.state || '')
          .trim()
          .toLowerCase();
        if (
          latestRecord &&
          (context.captureStarted ||
            detailStatus === DETAIL_CAPTURE_STATUS.CAPTURING ||
            traceState === 'capturing')
        ) {
          const failure = classifyDetailCaptureFailure(effectiveError, {
            stage: context.activeStage || 'unknown',
          });
          const runnerContextInterrupted = Boolean(
            runnerContext?.ownsRunnerTab &&
              failure.code ===
                DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED,
          );
          if (runnerContextInterrupted) {
            runnerInterrupted = true;
          }
          const terminalTraceState = canceledByUser
            ? 'cancelled'
            : securityBlocked
              ? 'security_blocked'
              : integrityBlocked
                ? 'integrity_blocked'
              : runnerContextInterrupted
                ? 'runner_interrupted'
                : 'failed';
          const failedPayload = applyDetailCapturePatch(
            latestRecord.payload,
            createDetailCapturePatch({
              status: DETAIL_CAPTURE_STATUS.FAILED,
              startedAt: context.startedAt || Date.now(),
              finishedAt: Date.now(),
              error: failure.userMessage,
              failureCode: failure.code,
              failureStage: failure.stage,
              failureCategory: failure.category,
              diagnosticMessage: failure.diagnosticMessage,
              noteUrl: context.noteUrl || '',
            }),
          );
          const terminalTraceTransition = transitionRecordCaptureTrace(
            latestRecord,
            failedPayload,
            terminalTraceState,
          );
          try {
            await updateRecord(context.recordId, {
              status: RECORD_STATUS.DRAFT,
              payload: terminalTraceTransition.payload,
            });
          } catch (updateError) {
            console.warn(
              '[CaptureSync] detail terminal record update failed (ignored):',
              updateError?.message || updateError,
            );
          }
          await sendCaptureTraceBindingsToTab(runnerContext.sourceTabId, [
            terminalTraceTransition.binding,
          ]);

          if (!results.some((item) => item?.recordId === context.recordId)) {
            results.push({
              recordId: context.recordId,
              ok: false,
              reason: failure.code,
              category: failure.category,
              stage: failure.stage,
              message: `${context.markerLabel}：${failure.userMessage}`,
              diagnosticMessage: failure.diagnosticMessage,
              canceled: canceledByUser,
              securityBlocked,
              integrityBlocked,
              fatal: integrityBlocked,
              stopBatch: integrityBlocked,
              runnerInterrupted: runnerContextInterrupted,
              ...context.captureTraceFields,
            });
            if (!canceledByUser) {
              failedCount += 1;
            }
          }

          await reportProgressFailSoft(onProgress, {
            phase: canceledByUser
              ? 'detail_item_cancelled'
              : 'detail_item_failed',
            message: canceledByUser
              ? `${context.progressLabel}：补采已中止`
              : `${context.progressLabel}：补采异常终止，${failure.userMessage}`,
            recordId: context.recordId,
            current: context.current || results.length,
            total: uniqueRecordIds.length,
            successCount,
            failedCount,
            filteredCount,
            runnerTabId: runnerContext.runnerTabId,
            ...context.captureTraceFields,
          }, 'detail top-level recovery');
        }
      } catch (recoveryError) {
        console.warn(
          '[CaptureSync] detail trace terminal recovery failed (ignored):',
          recoveryError?.message || recoveryError,
        );
      }
    }
    activeDetailItemContext = null;
  } finally {
    if (detailPrefetchPipeline) {
      await detailPrefetchPipeline.stop().catch((error) => {
        console.warn('[CaptureSync] stop detail prefetch pipeline failed:', error);
      });
    }
    const ownedRunnerContexts = runnerContexts.filter(
      (context) => context?.ownsRunnerTab,
    );
    if (ownedRunnerContexts.length > 0) {
      try {
        const closedResults = await closeOwnedDetailRunnerTabs(
          ownedRunnerContexts.map((context) => ({
            runnerTabId: context.runnerTabId,
            sourceTabId: context.sourceTabId,
            ownsRunnerTab: true,
          })),
        );
        const closedCount = closedResults.filter((item) => item.closed).length;
        await reportProgressFailSoft(onProgress, {
          phase: 'detail_runner_closed',
          message:
            closedCount > 0
              ? `${closedCount} 个详情工作页已安全关闭`
              : '详情工作页已由用户关闭',
          current: results.length,
          total: uniqueRecordIds.length,
          successCount,
          failedCount,
          filteredCount,
          runnerTabId: runnerContext?.runnerTabId || null,
          runnerTabIds: ownedRunnerContexts.map(
            (context) => context.runnerTabId,
          ),
          sourceTabId: runnerContext?.sourceTabId || null,
          runnerRole: 'detail_worker',
        }, 'detail runners closed');
      } catch (error) {
        console.warn('[CaptureSync] close detail runner tabs failed:', error);
        await reportProgressFailSoft(onProgress, {
          phase: 'detail_runner_cleanup_failed',
          message: '详情采集已停止，但部分工作页未能自动关闭，请手动关闭',
          current: results.length,
          total: uniqueRecordIds.length,
          successCount,
          failedCount,
          filteredCount,
          runnerTabId: runnerContext?.runnerTabId || null,
          runnerTabIds: ownedRunnerContexts.map(
            (context) => context.runnerTabId,
          ),
          failedRunnerTabIds: error?.failedTabIds || [],
          sourceTabId: runnerContext?.sourceTabId || null,
          runnerRole: 'detail_worker',
        }, 'detail runners cleanup failed');
      }
    } else if (runnerContext?.shouldRestoreSourcePage) {
      void restoreSourcePageIfNeeded(
        runnerContext.runnerTabId,
        runnerContext.sourcePageUrl,
        runnerContext.sourcePageScrollY,
        {timeoutMs: normalizedDetailNavTimeoutMs},
      ).catch((error) => {
        console.warn('[CaptureSync] restore source page failed:', error);
      });
    } else if (runnerContext?.shouldRestoreRuntimeContext) {
      void restoreSourceRuntimeContextIfNeeded({
        tabId: runnerContext.runnerTabId,
        sourcePageUrl: runnerContext.sourcePageUrl,
        sourcePlatform: runnerContext.sourcePlatform,
        sourcePageType: runnerContext.sourcePageType,
      }).catch((error) => {
        console.warn('[CaptureSync] restore source runtime context failed:', error);
      });
    }
  }

  const processedCount = results.length;
  const failureStageSummary = results.reduce((summary, item) => {
    if (item?.ok !== false) return summary;
    const stage = String(item.stage || item.reason || 'unknown').trim() || 'unknown';
    summary[stage] = (summary[stage] || 0) + 1;
    return summary;
  }, {});
  const enhancementStage = buildDetailEnhanceStage({
    status:
      canceled || runnerInterrupted || securityBlocked || integrityBlocked
        ? 'partial'
        : batchUnexpectedError || failedCount > 0
          ? 'completed_with_failures'
          : 'completed',
    targetCount: uniqueRecordIds.length,
    processedCount,
    successCount,
    failedCount,
    filteredCount,
    keywordFilterMode: detailKeywordFilterEnabled ? 'detail' : '',
    keywordFilterEnabled: detailKeywordFilterEnabled,
    keywordFilteredCount: detailKeywordFilteredCount,
    currentStage: canceled
      ? 'detail_batch_canceled'
      : securityBlocked
        ? 'detail_security_blocked'
        : integrityBlocked
          ? 'detail_integrity_blocked'
        : runnerInterrupted
          ? 'detail_batch_interrupted'
          : batchUnexpectedError
            ? 'detail_batch_failed'
            : 'detail_batch_done',
    failureStageSummary,
  });
  void recordDiagnosticStage({
    ...enhancementStage,
    taskContext: getActiveTaskContext(),
    featureKey: 'capture.enhancement',
    parentFeatureKey: 'capture.enhancement',
    source: 'capture-sync',
  }).catch(() => null);

  if (onProgress) {
    const skipNote = skippedCount > 0 ? `，跳过 ${skippedCount} 条(之前已采过)` : '';
    await reportProgressFailSoft(onProgress, {
      phase: canceled
        ? 'detail_batch_canceled'
        : securityBlocked
          ? 'detail_security_blocked'
          : integrityBlocked
            ? 'detail_integrity_blocked'
          : runnerInterrupted
            ? 'detail_batch_interrupted'
            : batchUnexpectedError
              ? 'detail_batch_failed'
              : 'detail_batch_done',
      message: canceled
        ? `详情补采已中止：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`
        : securityBlocked
          ? `详情补采遇到安全验证并已停止：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`
          : integrityBlocked
            ? `详情补采因作品身份无法确认而停止：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`
          : runnerInterrupted
            ? `详情工作页中断，已停止剩余任务：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`
            : batchUnexpectedError
              ? `详情补采异常终止：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`
              : `详情补采完成：成功 ${successCount}，失败 ${failedCount}，过滤 ${filteredCount}${skipNote}`,
      current: processedCount,
      total: uniqueRecordIds.length,
      successCount,
      failedCount,
      filteredCount,
      skippedCount,
      runnerRecoveryCount: detailRunnerRecoveryCount,
      runnerTabId: runnerContext.runnerTabId,
    }, 'detail batch terminal');
  }

  return {
    ok:
      !canceled &&
      !runnerInterrupted &&
      !securityBlocked &&
      !integrityBlocked &&
      !batchUnexpectedError &&
      failedCount === 0,
    canceled,
    runnerInterrupted,
    recoveryRequired: runnerInterrupted,
    runnerRecoveryCount: detailRunnerRecoveryCount,
    securityBlocked, // 撞平台安全限制 → 主循环据此停整轮无人值守
    integrityBlocked,
    fatal: integrityBlocked,
    stopBatch: integrityBlocked,
    total: uniqueRecordIds.length,
    processedCount,
    successCount,
    failedCount,
    filteredCount,
    skippedCount,
    results,
    diagnostics: {
      stageTrace: [enhancementStage],
    },
    error: integrityBlocked
      ? {
          code: 'FATAL_DOUYIN_IDENTITY_MISMATCH',
          message: '抖音作品身份无法确认，已停止剩余采集且未写入未验证数据',
          fatal: true,
        }
      : batchUnexpectedError
        ? {
            code: 'UNEXPECTED_ERROR',
            message:
              batchUnexpectedError?.message || '详情补采发生未预期错误',
          }
        : null,
  };
}

export function resolveSyncInputForRecord(record, target = {}) {
  if (!record || typeof record !== 'object') {
    return {
      platform: 'unknown',
      recordType: '',
      syncType: '',
      payload: {},
      workflow: 'shared_unknown',
      tableName: '',
    };
  }

  const recordType = String(record.type || record.recordType || '').trim();
  if (isRecordHydratedAsSingleNote(record)) {
    const payload = sanitizeDouyinPayloadAuthorsForSync(
      record,
      mergeHydratedDetailIntoRecordPayload(record),
    );
    return buildPlatformSyncInput(record, target, {
      recordType,
      syncType: recordType,
      payload,
    });
  }

  const payload = sanitizeDouyinPayloadAuthorsForSync(
    record,
    record.payload && typeof record.payload === 'object' ? record.payload : {},
  );
  return buildPlatformSyncInput(record, target, {
    recordType,
    syncType: recordType,
    payload,
  });
}

function isRecordHydratedAsSingleNote(record) {
  if (!record || typeof record !== 'object') return false;
  if (
    record.type !== SYNC_TYPE.BLOGGER_NOTES &&
    record.type !== SYNC_TYPE.KEYWORD_NOTES
  ) {
    return false;
  }

  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const status = String(payload.detailCaptureStatus || '').trim().toLowerCase();
  if (status !== DETAIL_CAPTURE_STATUS.DONE) {
    return false;
  }

  return Boolean(payload.detailPayload && typeof payload.detailPayload === 'object');
}

function normalizeSingleNotePayloadForSync(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const normalized = sanitizeMediaFieldsForStorage(ensureBloggerMetricsFields(
    applyCommentStatusToPayload(base, {}),
  ));
  return normalized;
}

function sanitizeMediaFieldsForStorage(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const platform = resolvePayloadPlatform(base);
  const noteType = getSingleNoteType(base);

  const sanitizeUrlList = (list) => {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const next = [];
    list.forEach((item) => {
      const normalized = normalizeMediaUrlForStorage(item);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      next.push(normalized);
    });
    return next;
  };

  if (noteType === 'image') {
    const imageUrls = sanitizeUrlList([
      ...(Array.isArray(base.imageUrls) ? base.imageUrls : []),
      ...(Array.isArray(base.images) ? base.images : []),
    ]);
    const coverImageUrl =
      normalizeMediaUrlForStorage(base.coverImageUrl) || imageUrls[0] || '';
    const orderedImageUrls = sanitizeUrlList([
      coverImageUrl,
      ...imageUrls,
    ]);

    return clearPlayableMediaFields({
      ...base,
      coverImageUrl,
      imageUrls: orderedImageUrls,
    });
  }

  if (platform !== 'douyin') {
    return base;
  }

  const sanitizeList = (list, kind) => {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const next = [];
    list.forEach((item) => {
      const normalized = normalizeMediaUrlForStorage(item);
      if (!normalized || seen.has(normalized)) return;
      if (!isLikelyDownloadableDouyinMediaUrlForStorage(normalized, kind)) return;
      seen.add(normalized);
      next.push(normalized);
    });
    return next;
  };

  const videoUrls = sanitizeList(
    [base.videoUrl, ...(Array.isArray(base.videoUrls) ? base.videoUrls : [])],
    'video',
  );
  const audioUrls = sanitizeList(
    [
      base.audioUrl,
      base.musicUrl,
      ...(Array.isArray(base.audioUrls) ? base.audioUrls : []),
      ...(Array.isArray(base.musicUrls) ? base.musicUrls : []),
    ],
    'audio',
  );

  return {
    ...base,
    videoUrl: videoUrls[0] || '',
    videoUrls,
    audioUrl: audioUrls[0] || '',
    audioUrls,
    musicUrl: audioUrls[0] || '',
    musicUrls: audioUrls,
  };
}

function normalizeDetailPayloadAgainstRecord(record, detailPayload) {
  const item = getFirstPayloadItem(record?.payload);
  const base = protectDouyinDetailAuthorAgainstListItem(
    record,
    detailPayload && typeof detailPayload === 'object'
      ? {...detailPayload}
      : {},
    item,
  );

  if (getSingleNoteType(base) !== 'image') {
    return base;
  }

  const listCoverImageUrl = normalizeMediaUrlForStorage(
    item?.coverImageUrl ||
      item?.coverUrl ||
      item?.coverImage ||
      item?.cover ||
      '',
  );
  if (!listCoverImageUrl) {
    return base;
  }

  const imageUrls = [
    listCoverImageUrl,
    ...(Array.isArray(base.imageUrls) ? base.imageUrls : []),
    ...(Array.isArray(base.images) ? base.images : []),
  ];

  return {
    ...base,
    coverImageUrl: listCoverImageUrl,
    imageUrls,
  };
}

function protectDouyinDetailAuthorAgainstListItem(
  record,
  detailPayload,
  listItem,
) {
  const base = detailPayload && typeof detailPayload === 'object'
    ? detailPayload
    : {};
  const platform = String(
    record?.platform || base?.platform || resolvePayloadPlatform(base),
  ).trim().toLowerCase();
  if (platform !== 'douyin') {
    return base;
  }

  const detailAuthor = pickDouyinAuthorName(
    base.author,
    base.authorName,
    base.nickname,
    base.bloggerName,
  );
  const listAuthor = pickDouyinAuthorName(
    listItem?.author,
    listItem?.authorName,
    listItem?.nickname,
    listItem?.bloggerName,
  );
  const expectedNoteId =
    resolveExpectedDouyinCommentNoteId(record, base.url || base.noteUrl) ||
    extractDouyinDetailGuardItemId(listItem?.noteId) ||
    extractDouyinDetailGuardItemId(listItem?.url);
  const detailNoteIds = [
    base.noteId,
    base.url,
    base.noteUrl,
  ]
    .map(extractDouyinDetailGuardItemId)
    .filter(Boolean);
  const detailIdentityVerified = Boolean(
    expectedNoteId &&
      detailNoteIds.length > 0 &&
      detailNoteIds.every((noteId) => noteId === expectedNoteId),
  );
  // 详情采集已经用作品 ID 绑定到目标作品时，详情作者才是该作品的
  // 第一手证据。搜索列表可能复用旧卡片，不能反向覆盖详情作者。
  // 详情未绑定或作者缺失时，列表作者只作为完整的一组兜底信息。
  const preferDetailAuthor = Boolean(detailAuthor && detailIdentityVerified);
  const preferListAuthor = Boolean(listAuthor && !preferDetailAuthor);
  const author = preferDetailAuthor
    ? detailAuthor
    : preferListAuthor
      ? listAuthor
      : detailAuthor;
  const authorUrl = preferDetailAuthor
    ? pickTrustedDouyinAuthorUrl([
        base.authorProfileUrl,
        base.authorUrl,
        base.bloggerProfileUrl,
        base.profileUrl,
      ])
    : preferListAuthor
      ? pickTrustedDouyinAuthorUrl([
          listItem?.authorProfileUrl,
          listItem?.authorUrl,
          listItem?.bloggerProfileUrl,
          listItem?.profileUrl,
        ])
      : '';
  const detailAuthorId = String(base.authorId || base.bloggerId || '').trim();
  const listAuthorId = String(
    listItem?.authorId || listItem?.bloggerId || '',
  ).trim();
  const authorId = preferDetailAuthor
    ? !/^self$/i.test(detailAuthorId)
      ? detailAuthorId
      : ''
    : preferListAuthor
      ? !/^self$/i.test(listAuthorId)
        ? listAuthorId
        : ''
      : '';

  base.author = author;
  base.authorName = author;
  if (Object.prototype.hasOwnProperty.call(base, 'nickname')) {
    base.nickname = author;
  }
  if (Object.prototype.hasOwnProperty.call(base, 'bloggerName')) {
    base.bloggerName = author;
  }
  base.authorId = authorId;
  base.authorUrl = authorUrl;
  base.bloggerProfileUrl = authorUrl;
  if (Object.prototype.hasOwnProperty.call(base, 'authorProfileUrl')) {
    base.authorProfileUrl = authorUrl;
  }
  if (Object.prototype.hasOwnProperty.call(base, 'profileUrl')) {
    base.profileUrl = authorUrl;
  }
  return base;
}

function pickTrustedDouyinAuthorUrl(...candidateGroups) {
  for (const candidates of candidateGroups) {
    for (const candidate of candidates || []) {
      const url = String(candidate || '').trim();
      if (url && !isDouyinOwnProfileUrl(url)) return url;
    }
  }
  return '';
}

function sanitizeDouyinPayloadAuthorsForSync(record, payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const platform = String(
    record?.platform || base.platform || resolvePayloadPlatform(base),
  ).trim().toLowerCase();
  if (platform !== 'douyin') {
    return base;
  }

  const next = {...base};
  const items = Array.isArray(base.items) ? base.items : [];
  const firstItem = items[0] && typeof items[0] === 'object' ? items[0] : null;
  if (items.length > 0) {
    next.items = items.map((item) =>
      item && typeof item === 'object'
        ? protectDouyinDetailAuthorAgainstListItem(record, {...item}, null)
        : item,
    );
  } else {
    protectDouyinDetailAuthorAgainstListItem(record, next, null);
  }

  if (base.detailPayload && typeof base.detailPayload === 'object') {
    next.detailPayload = protectDouyinDetailAuthorAgainstListItem(
      record,
      {...base.detailPayload},
      firstItem,
    );
  }
  return next;
}

function clearPlayableMediaFields(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const media = base.media && typeof base.media === 'object'
    ? {
        ...base.media,
        videoUrl: '',
        videoURL: '',
        video_url: '',
        videoLink: '',
        video_link: '',
        playUrl: '',
        play_url: '',
        videoUrls: [],
        videoList: [],
        videos: [],
        audioUrl: '',
        audioURL: '',
        audio_url: '',
        musicUrl: '',
        music_url: '',
        audioUrls: [],
        musicUrls: [],
      }
    : base.media;

  return {
    ...base,
    media,
    videoUrl: '',
    videoURL: '',
    video_url: '',
    videoLink: '',
    video_link: '',
    playUrl: '',
    play_url: '',
    videoUrls: [],
    videoList: [],
    videos: [],
    audioUrl: '',
    audioURL: '',
    audio_url: '',
    audioUrls: [],
    musicUrl: '',
    music_url: '',
    musicUrls: [],
    audioAvailability: 'not_collected',
  };
}

function resolvePayloadPlatform(payload) {
  const explicit = String(payload?.platform || '').trim().toLowerCase();
  if (explicit && explicit !== 'unknown') {
    return explicit;
  }

  const candidates = [
    payload?.url,
    payload?.noteUrl,
    payload?.authorUrl,
  ];

  for (const candidate of candidates) {
    const detected = detectPlatformFromUrl(String(candidate || ''));
    if (detected && detected !== 'unknown') {
      return detected;
    }
  }

  return 'unknown';
}

function normalizeMediaUrlForStorage(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = value.trim();
  if (!normalized) return '';
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://');
  }
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function isLikelyDownloadableDouyinMediaUrlForStorage(url, kind = 'video') {
  const lower = normalizeMediaUrlForStorage(url).toLowerCase();
  if (!lower) return false;
  if (/^https?:\/\/v\.douyin\.com\//i.test(lower)) return false;
  if (lower.endsWith('.html')) return false;
  if (/^https?:\/\/(?:www\.)?douyin\.com\/(?!aweme\/v1\/play\/)/i.test(lower)) {
    return false;
  }

  if (kind === 'audio') {
    return Boolean(
      lower.includes('xtag=audio') ||
      lower.includes('media-audio') ||
      lower.includes('mime_type=audio_') ||
      lower.includes('ies-music') ||
      lower.includes('music-east') ||
      lower.includes('/obj/ies-music-') ||
      lower.includes('/audio/') ||
      /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(lower)
    );
  }

  return Boolean(
    !lower.includes('media-audio') &&
    !lower.includes('mime_type=audio_') &&
    (
      lower.includes('/aweme/v1/play/') ||
      lower.includes('mime_type=video_') ||
      lower.includes('/video/tos/') ||
      lower.includes('video_id=') ||
      lower.includes('douyinvod.com') ||
      lower.includes('bytevod.com') ||
      lower.includes('zjcdn.com') ||
      /\.(mp4|m3u8|mpd|webm)(\?|$)/i.test(lower)
    )
  );
}

function mergeHydratedDetailIntoRecordPayload(record) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  const normalizedDetail = normalizeSingleNotePayloadForSync(payload.detailPayload);
  if (!normalizedDetail || typeof normalizedDetail !== 'object') {
    return payload;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const firstItem =
    items[0] && typeof items[0] === 'object' ? items[0] : {};
  // 必须在合并列表字段之前判断详情作者是否真的与目标作品绑定。
  // 否则详情缺少 noteId/url 时，会继承列表作品 ID，并被误判为“详情已验证”，
  // 进而让另一条作品的作者覆盖当前列表作者。
  const detail = protectDouyinDetailAuthorAgainstListItem(
    record,
    {...normalizedDetail},
    firstItem,
  );
  const mergedItem = {
    ...firstItem,
    ...detail,
  };
  protectDouyinDetailAuthorAgainstListItem(record, mergedItem, firstItem);

  // 同一抖音作品的详情正文可能先返回折叠 DOM，稍后才有完整 desc。
  // 只有 DOM 未经接口验证时才保护长版本；完整 API desc 允许真实编辑变短。
  const listTitle = /^抖音搜索结果/.test(String(firstItem.title || ''))
    ? ''
    : firstItem.title;
  const detailPlatform = String(
    record?.platform || detail?.platform || resolvePayloadPlatform(detail),
  ).trim().toLowerCase();
  const detailTextVerified =
    String(detail.contentCompleteness || '').trim().toLowerCase() === 'complete' ||
    String(detail.contentSource || '').trim().toLowerCase() === 'api_detail';
  if (detailPlatform === 'douyin' && !detailTextVerified) {
    mergedItem.title = pickMoreCompleteCapturedText(listTitle, detail.title);
    mergedItem.content = pickMoreCompleteCapturedText(
      firstItem.content || listTitle,
      detail.content || detail.title,
    );
  }

  // 详情增强若返回空标题/正文(典型:抖音图文 desc 常为空),别用空覆盖搜索卡片已采到的真实值。
  // 卡片兜底占位「抖音搜索结果 N」不算真标题,不回填;抖音正文=标题,缺正文时用标题补。
  if (!mergedItem.title && firstItem.title && !/^抖音搜索结果/.test(String(firstItem.title))) {
    mergedItem.title = firstItem.title;
  }
  if (!mergedItem.content && firstItem.content) mergedItem.content = firstItem.content;
  if (!mergedItem.content && mergedItem.title) mergedItem.content = mergedItem.title;

  if (!mergedItem.url && mergedItem.noteUrl) mergedItem.url = mergedItem.noteUrl;
  if (!mergedItem.noteUrl && mergedItem.url) mergedItem.noteUrl = mergedItem.url;
  if (!mergedItem.title && mergedItem.noteTitle) mergedItem.title = mergedItem.noteTitle;
  if (!mergedItem.noteTitle && mergedItem.title) mergedItem.noteTitle = mergedItem.title;
  if (!mergedItem.author && mergedItem.authorName) mergedItem.author = mergedItem.authorName;
  if (!mergedItem.authorName && mergedItem.author) mergedItem.authorName = mergedItem.author;
  if ((mergedItem.likes == null || mergedItem.likes === '') && mergedItem.likeCount != null) {
    mergedItem.likes = mergedItem.likeCount;
  }
  if (
    (mergedItem.likeCount == null || mergedItem.likeCount === '') &&
    mergedItem.likes != null
  ) {
    mergedItem.likeCount = mergedItem.likes;
  }
  if (!mergedItem.noteType && mergedItem.type) mergedItem.noteType = mergedItem.type;
  if (!mergedItem.type && mergedItem.noteType) mergedItem.type = mergedItem.noteType;

  const mergedItems = items.length > 0 ? [mergedItem, ...items.slice(1)] : [mergedItem];
  return {
    ...payload,
    detailPayload:
      payload.detailPayload && typeof payload.detailPayload === 'object'
        ? {
            ...payload.detailPayload,
            title: mergedItem.title,
            content: mergedItem.content,
          }
        : payload.detailPayload,
    items: mergedItems,
    totalCount: payload.totalCount || mergedItems.length,
  };
}

export function pickMoreCompleteCapturedText(existingValue, incomingValue) {
  const existing = String(existingValue || '').trim();
  const incoming = String(incomingValue || '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  const comparable = value => String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s*(?:\.{3}|…+)\s*展开\s*$/u, '')
    .replace(/\s+/gu, '');
  const existingComparable = comparable(existing);
  const incomingComparable = comparable(incoming);
  if (
    incomingComparable.length < existingComparable.length &&
    existingComparable.startsWith(incomingComparable)
  ) {
    return existing;
  }
  if (
    existingComparable.length < incomingComparable.length &&
    incomingComparable.startsWith(existingComparable)
  ) {
    return incoming;
  }
  return incoming;
}

function isSyncCancellationRequested(shouldStop, signal = null) {
  if (signal?.aborted === true) return true;
  if (typeof shouldStop !== 'function') return false;
  try {
    return shouldStop() === true;
  } catch {
    return true;
  }
}

function buildCanceledSyncResult(overrides = {}) {
  return {
    ok: false,
    canceled: true,
    skipped: true,
    reason: 'capture_task_canceled',
    message: '任务已取消，未继续同步',
    error: null,
    ...overrides,
  };
}

async function resetCanceledSyncState() {
  await updateSync({
    status: SYNC_STATUS.IDLE,
    error: null,
  }).catch(() => null);
}

function buildCanceledBatchSyncResult({
  requestedRecordIds = [],
  recordIdsToSync = [],
  skippedRecordIds = [],
  results = [],
  commentLeadsSyncedCount = 0,
  commentLeadsSkippedCount = 0,
  commentLeadsFailedCount = 0,
  commentLeadsCanceledRecordIds = [],
} = {}) {
  const completedRecordIds = new Set(
    results.map((result) => String(result?.recordId || '').trim()).filter(Boolean),
  );
  const canceledRecordIds = recordIdsToSync.filter(
    (recordId) => !completedRecordIds.has(recordId),
  );
  return buildCanceledSyncResult({
    skipped: false,
    results,
    successCount: results.filter((result) => result?.success === true).length,
    failedCount: results.filter((result) => result?.success === false).length,
    canceledCount: canceledRecordIds.length,
    canceledRecordIds,
    requestedCount: requestedRecordIds.length,
    syncedCount: recordIdsToSync.length - canceledRecordIds.length,
    skippedCount: skippedRecordIds.length,
    commentLeadsSyncedCount,
    commentLeadsSkippedCount,
    commentLeadsFailedCount,
    commentLeadsCanceledCount: commentLeadsCanceledRecordIds.length,
    commentLeadsCanceledRecordIds: [...commentLeadsCanceledRecordIds],
  });
}

/**
 * 同步单条记录
 * @param {string} recordId - 记录 ID
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 同步结果
 */
export async function syncRecord(recordId, onProgress = null, options = {}) {
  const startedAt = Date.now();
  const shouldStop = options?.shouldStop;
  const signal = options?.signal || null;
  const historyTrigger = String(options?.trigger || 'single').trim() || 'single';
  try {
    if (isSyncCancellationRequested(shouldStop, signal)) {
      await resetCanceledSyncState();
      return buildCanceledSyncResult({recordId});
    }
    if (onProgress) {
      onProgress({
        phase: 'sync_start',
        message: '正在同步到后台...',
        recordId,
      });
    }

    // 更新同步状态
    await updateSync({
      status: SYNC_STATUS.SYNCING,
      lastAttemptedAt: new Date().toISOString(),
      error: null,
    });

    // 更新记录状态
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
    });

    // 获取目标配置
    const target = await getTarget();

    // 从数据池获取记录
    const record = await getRecord(recordId);

    if (!record) {
      throw new Error('记录不存在');
    }

    const requestTarget = buildSyncTargetPayload(target);
    const captureSettings = options?.captureSettings || await getCaptureSettings();
    const commentLeadsConfig = normalizeCommentLeadsConfig(
      options?.commentLeadsConfig || {},
    );
    const syncInput = resolveSyncInputForRecord(record, requestTarget);
    syncInput.payload = applySyncPreferencesToPayload(
      syncInput.payload,
      captureSettings,
    );
    const resolvedTableName = syncInput.tableName || resolveSyncTableName(requestTarget, syncInput.syncType);

    console.log('[CaptureSync] Sync request target:', {
      feishuAppToken: requestTarget.feishuAppToken,
      tableId: resolvedTableName,
      recordId,
      platform: syncInput.platform,
      syncType: syncInput.syncType,
      workflow: syncInput.workflow,
    });

    // 调用后端 sync API
    const syncResult = await sync(
      {
        syncType: syncInput.syncType,
        target: requestTarget,
        payload: syncInput.payload,
        captureTaskId:
          String(options?.captureTaskId || '').trim() ||
          resolveActiveCloudCaptureTaskId(),
        captureTaskItemAttemptId: String(
          options?.captureTaskItemAttemptId || '',
        ).trim(),
        captureTaskItemRequestHash: String(
          options?.captureTaskItemRequestHash || '',
        ).trim(),
      },
      {shouldStop, signal},
    );

    if (syncResult?.canceled) {
      await resetCanceledSyncState();
      return buildCanceledSyncResult({recordId, rawResponse: syncResult});
    }

    const debugUrl = extractDebugUrl(syncResult);

    // 检查同步是否成功
    if (syncResult.ok) {
      // 同步成功
      await markRecordSynced(recordId, debugUrl);
      let commentLeadsOutcome = {
        enabled: commentLeadsConfig.enabled,
        skipped: true,
        skipReason: 'disabled',
        matchedCount: 0,
      };

      if (isCommentLeadsEligibleSyncType(syncInput.syncType)) {
        const leadResult = buildCommentLeadsPayloadForRecord(
          {
            type: syncInput.syncType,
            payload: syncInput.payload,
          },
          commentLeadsConfig,
          { preferStored: true },
        );
        const latestRecord = (await getRecord(recordId)) || record;
        const basePayload =
          latestRecord?.payload && typeof latestRecord.payload === 'object'
            ? latestRecord.payload
            : {};
        const canSyncStoredLeads = leadResult.source === 'stored' && Boolean(leadResult.payload);

        if (!commentLeadsConfig.enabled && !canSyncStoredLeads) {
          const nextPayload = applyCommentLeadsSyncState(basePayload, {
            config: commentLeadsConfig,
            leadResult,
            syncStatus: 'not_started',
            syncError: '',
          });
          await updateRecord(recordId, { payload: nextPayload });
        } else if (leadResult.skipReason) {
          const nextPayload = applyCommentLeadsSyncState(basePayload, {
            config: commentLeadsConfig,
            leadResult,
            syncStatus: 'skipped',
            syncError: '',
          });
          await updateRecord(recordId, { payload: nextPayload });
          commentLeadsOutcome = {
            enabled: commentLeadsConfig.enabled || canSyncStoredLeads,
            skipped: true,
            skipReason: leadResult.skipReason,
            matchedCount: leadResult.matchedCount,
          };
        } else if (leadResult.payload) {
          if (isSyncCancellationRequested(shouldStop, signal)) {
            await updateRecord(recordId, {
              status: RECORD_STATUS.FAILED,
              lastSyncedAt: Date.now(),
              lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
            });
            await resetCanceledSyncState();
            return buildCanceledSyncResult({
              recordId,
              partialContentSuccess: true,
            });
          }
          const leadsSyncResult = await sync(
            {
              syncType: SYNC_TYPE.COMMENT_LEADS,
              target: requestTarget,
              payload: leadResult.payload,
            },
            {shouldStop, signal},
          );
          if (leadsSyncResult?.canceled) {
            await updateRecord(recordId, {
              status: RECORD_STATUS.FAILED,
              lastSyncedAt: Date.now(),
              lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
            });
            await resetCanceledSyncState();
            return buildCanceledSyncResult({
              recordId,
              partialContentSuccess: true,
              rawResponse: {
                content: syncResult,
                commentLeads: leadsSyncResult,
              },
            });
          }
          const leadsDebugUrl = extractDebugUrl(leadsSyncResult);
          if (!leadsSyncResult.ok) {
            const syncErrorMessage =
              leadsSyncResult.error?.message ||
              leadsSyncResult.message ||
              '客资同步失败';
            const nextPayload = applyCommentLeadsSyncState(basePayload, {
              config: commentLeadsConfig,
              leadResult,
              syncStatus: 'failed',
              syncError: syncErrorMessage,
            });
            await updateRecord(recordId, {
              status: RECORD_STATUS.FAILED,
              lastSyncedAt: Date.now(),
              lastSyncReason: 'COMMENT_LEADS_SYNC_FAILED',
              lastSyncDebugUrl: leadsDebugUrl || null,
              payload: nextPayload,
            });
            await updateSync({
              status: SYNC_STATUS.FAILED,
              error: {
                ...(leadsSyncResult.error || {}),
                code: 'COMMENT_LEADS_SYNC_FAILED',
                message: syncErrorMessage,
                debugUrl: leadsDebugUrl || null,
              },
            });
            if (onProgress) {
              onProgress({
                phase: 'sync_failed',
                message: '内容表已同步，客资表同步失败',
                recordId,
              });
            }
            const result = {
              ok: false,
              recordId,
              platform: syncInput.platform,
              type: syncInput.syncType,
              workflow: syncInput.workflow,
              debugUrl: leadsDebugUrl || debugUrl,
              reason: 'COMMENT_LEADS_SYNC_FAILED',
              message: '内容表已同步，客资表同步失败',
              rawResponse: {
                content: syncResult,
                commentLeads: leadsSyncResult,
              },
              partialContentSuccess: true,
              commentLeads: {
                enabled: true,
                skipped: false,
                matchedCount: leadResult.matchedCount,
                ok: false,
              },
              error: {
                code: 'COMMENT_LEADS_SYNC_FAILED',
                message: syncErrorMessage,
              },
            };
            await appendSingleSyncHistoryEntry({
              requestTarget,
              syncInput,
              recordId,
              result,
              startedAt,
              trigger: historyTrigger,
            });
            return result;
          }

          const nextPayload = applyCommentLeadsSyncState(basePayload, {
            config: commentLeadsConfig,
            leadResult,
            syncStatus: 'done',
            syncError: '',
          });
          await updateRecord(recordId, { payload: nextPayload });
          commentLeadsOutcome = {
            enabled: commentLeadsConfig.enabled || canSyncStoredLeads,
            skipped: false,
            skipReason: '',
            matchedCount: leadResult.matchedCount,
            ok: true,
          };
        }
      }

      await updateSync({
        status: SYNC_STATUS.SUCCESS,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      });

      if (onProgress) {
        onProgress({
          phase: 'synced',
          message: '同步成功！',
          recordId,
        });
      }

      const result = {
        ok: true,
        recordId,
        platform: syncInput.platform,
        type: syncInput.syncType,
        workflow: syncInput.workflow,
        debugUrl,
        reason: ERROR_REASON.NONE,
        message: '同步成功',
        rawResponse: syncResult,
        commentLeads: isCommentLeadsEligibleSyncType(syncInput.syncType)
          ? commentLeadsOutcome
          : null,
        error: null,
      };
      trackSyncSuccess(1, {
        syncType: syncInput.syncType,
        workflow: syncInput.workflow,
        source: 'single_record_sync',
      });
      await appendSingleSyncHistoryEntry({
        requestTarget,
        syncInput,
        recordId,
        result,
        startedAt,
        trigger: historyTrigger,
      });
      return result;
    } else {
      // 同步失败
      await updateRecord(recordId, {
        status: RECORD_STATUS.FAILED,
        lastSyncedAt: Date.now(),
        lastSyncReason: syncResult.error?.reason || syncResult.reason || 'SYNC_ERROR',
        lastSyncDebugUrl: debugUrl || null,
      });

      await updateSync({
        status: SYNC_STATUS.FAILED,
        error: {
          ...(syncResult.error || {}),
          debugUrl,
        },
      });

      if (onProgress) {
        onProgress({
          phase: 'sync_failed',
          message: `同步失败: ${syncResult.error?.message || '未知错误'}`,
          recordId,
        });
      }

      const result = {
        ok: false,
        recordId,
        platform: syncInput.platform,
        type: syncInput.syncType,
        workflow: syncInput.workflow,
        debugUrl,
        reason: syncResult.error?.reason || syncResult.reason || 'SYNC_ERROR',
        message: syncResult.error?.message || syncResult.message || '同步失败',
        rawResponse: syncResult,
        error: syncResult.error,
      };
      await appendSingleSyncHistoryEntry({
        requestTarget,
        syncInput,
        recordId,
        result,
        startedAt,
        trigger: historyTrigger,
      });
      return result;
    }
  } catch (error) {
    console.error('[CaptureSync] Sync record failed:', error);

    await updateRecord(recordId, {
      status: RECORD_STATUS.FAILED,
      lastSyncedAt: Date.now(),
      lastSyncReason: 'SYNC_ERROR',
      lastSyncDebugUrl: null,
    });

    await updateSync({
      status: SYNC_STATUS.FAILED,
      error: {
        code: 'SYNC_ERROR',
        message: error.message,
      },
    });

    const result = {
      ok: false,
      recordId,
      platform: 'unknown',
      type: null,
      workflow: 'shared_unknown',
      debugUrl: null,
      reason: 'SYNC_ERROR',
      message: error.message,
      rawResponse: null,
      error: {
        code: 'SYNC_ERROR',
        message: error.message,
      },
    };
    await appendSingleSyncHistoryEntry({
      requestTarget: null,
      syncInput: {
        platform: 'unknown',
        syncType: '',
        workflow: 'shared_unknown',
        payload: {},
      },
      recordId,
      result,
      startedAt,
      trigger: historyTrigger,
    });
    return result;
  }
}

function extractDebugUrl(syncResult) {
  if (!syncResult || typeof syncResult !== 'object') {
    return '';
  }

  const topLevelDebugUrl = syncResult.data?.debugUrl;
  if (typeof topLevelDebugUrl === 'string' && topLevelDebugUrl.trim()) {
    return topLevelDebugUrl.trim();
  }

  const nestedDebugUrl = syncResult.data?.cozeResult?.debug_url;
  if (typeof nestedDebugUrl === 'string' && nestedDebugUrl.trim()) {
    return nestedDebugUrl.trim();
  }

  return '';
}

async function appendSingleSyncHistoryEntry({
  requestTarget,
  syncInput,
  recordId,
  result,
  startedAt,
  trigger = 'single',
} = {}) {
  const safeSyncInput =
    syncInput && typeof syncInput === 'object'
      ? syncInput
      : {
          platform: 'unknown',
          syncType: '',
          workflow: 'shared_unknown',
          payload: {},
        };
  const safeResult = result && typeof result === 'object' ? result : {};
  const success = Boolean(safeResult.ok);
  const payload = safeSyncInput.payload && typeof safeSyncInput.payload === 'object'
    ? safeSyncInput.payload
    : {};

  await addSyncHistoryEntry({
    trigger,
    syncScope: 'pending',
    startedAt,
    finishedAt: Date.now(),
    totalCount: 1,
    requestedTotalCount: 1,
    skippedCount: 0,
    successCount: success ? 1 : 0,
    failedCount: success ? 0 : 1,
    debugUrl: safeResult.debugUrl || null,
    platform: safeSyncInput.platform || 'unknown',
    syncType: safeSyncInput.syncType || '',
    workflow: safeSyncInput.workflow || 'shared_unknown',
    target: buildSyncHistoryTarget(requestTarget, safeSyncInput),
    recordIds: recordId ? [recordId] : [],
    skippedRecordIds: [],
    items: [
      {
        recordId,
        platform: safeSyncInput.platform || 'unknown',
        type: safeSyncInput.syncType || '',
        workflow: safeSyncInput.workflow || 'shared_unknown',
        noteType:
          safeSyncInput.syncType === SYNC_TYPE.SINGLE_NOTE
            ? getSingleNoteType(payload)
            : null,
        success,
        reason: safeResult.reason || (success ? ERROR_REASON.NONE : 'SYNC_ERROR'),
        message: safeResult.message || (success ? '同步成功' : '同步失败'),
        debugUrl: safeResult.debugUrl || null,
        rawResponse: safeResult.rawResponse || null,
        error: safeResult.error || null,
      },
    ],
  });
}

/**
 * 批量同步记录
 * @param {Array<string>} recordIds - 记录 ID 数组
 * @param {Function} onProgress - 进度回调
 * @param {Object} options - 批量同步选项
 * @param {string} options.trigger - 触发来源（selected / all / single）
 * @param {string} options.syncScope - 同步范围（pending / all）
 * @returns {Promise<Object>} 批量同步结果
 */
export async function syncRecordBatch(recordIds, onProgress = null, options = {}) {
  try {
    return await runSyncRecordBatch(recordIds, onProgress, options);
  } catch (error) {
    await updateSync({
      status: SYNC_STATUS.FAILED,
      error: {
        code: 'BATCH_SYNC_ERROR',
        message: error?.message || '批量同步失败',
      },
    }).catch(() => null);

    void recordDiagnosticError({
      taskContext: getActiveTaskContext(),
      source: 'capture-sync',
      action: 'syncRecordBatch',
      status: 'failed',
      error: {
        code: 'BATCH_SYNC_ERROR',
        message: error?.message || '批量同步失败',
      },
      metadata: {
        requestedCount: Array.isArray(recordIds) ? recordIds.length : 0,
        trigger: options?.trigger || 'manual',
      },
    }).catch(() => null);

    if (onProgress) {
      onProgress({
        phase: 'sync_failed',
        message: `批量同步失败: ${error?.message || '未知错误'}`,
      });
    }

    throw error;
  }
}

async function runSyncRecordBatch(recordIds, onProgress = null, options = {}) {
  const startedAt = Date.now();
  const captureTaskId =
    resolveActiveCloudCaptureTaskId({
      taskId: String(options?.captureTaskId || '').trim(),
    }) || resolveActiveCloudCaptureTaskId();
  const shouldStop = options?.shouldStop;
  const signal = options?.signal || null;
  const requestedRecordIds = Array.isArray(recordIds)
    ? recordIds.filter((recordId) => typeof recordId === 'string' && recordId.trim())
    : [];
  const recordIdsToSync = requestedRecordIds.slice(0, MAX_SYNC_RECORDS_PER_BATCH);
  const skippedRecordIds = requestedRecordIds.slice(MAX_SYNC_RECORDS_PER_BATCH);
  if (isSyncCancellationRequested(shouldStop, signal)) {
    await resetCanceledSyncState();
    return buildCanceledBatchSyncResult({
      requestedRecordIds,
      recordIdsToSync,
      skippedRecordIds,
    });
  }
  const target = await getTarget();
  if (isSyncCancellationRequested(shouldStop, signal)) {
    await resetCanceledSyncState();
    return buildCanceledBatchSyncResult({
      requestedRecordIds,
      recordIdsToSync,
      skippedRecordIds,
    });
  }
  const requestTarget = buildSyncTargetPayload(target);
  const captureSettings = options?.captureSettings || await getCaptureSettings();
  const commentLeadsConfig = normalizeCommentLeadsConfig(
    options?.commentLeadsConfig || {},
  );
  const batchMonitorExecutionId =
    typeof options?.monitorExecutionId === 'string' &&
    options.monitorExecutionId.trim()
      ? options.monitorExecutionId.trim()
      : '';
  const batchCaptureTaskItemAttemptId = String(
    options?.captureTaskItemAttemptId || '',
  ).trim();
  const batchCaptureTaskItemRequestHash = String(
    options?.captureTaskItemRequestHash || '',
  ).trim();
  const sourceRecords = await getRecords(recordIdsToSync);
  const recordMap = new Map(sourceRecords.map((record) => [record.id, record]));
  const recordsToSync = recordIdsToSync
    .map((recordId) => recordMap.get(recordId))
    .filter(Boolean);
  const preparedRecordsToSync = recordsToSync.map((record) => {
    const syncInput = resolveSyncInputForRecord(record, requestTarget);
    const monitorExecutionId =
      batchMonitorExecutionId ||
      String(record?.monitorExecutionId || record?.payload?.monitorExecutionId || '')
        .trim();
    return {
      ...record,
      platform: syncInput.platform,
      syncType: syncInput.syncType,
      syncPayload: applySyncPreferencesToPayload(
        syncInput.payload,
        captureSettings,
      ),
      workflow: syncInput.workflow,
      sourceType: record.type,
      monitorExecutionId,
      captureTaskId,
      captureTaskItemAttemptId:
        batchCaptureTaskItemAttemptId ||
        String(record?.captureTaskItemAttemptId || '').trim(),
      captureTaskItemRequestHash:
        batchCaptureTaskItemRequestHash ||
        String(record?.captureTaskItemRequestHash || '').trim(),
      retryCommentLeadsOnly:
        commentLeadsConfig.enabled &&
        isCommentLeadsEligibleSyncType(syncInput.syncType) &&
        [
          'COMMENT_LEADS_SYNC_FAILED',
          'COMMENT_LEADS_SYNC_CANCELED',
        ].includes(String(record?.lastSyncReason || '').trim().toUpperCase()),
    };
  });
  const results = [];
  const contentRecordsToSync = preparedRecordsToSync.filter(
    (record) => !record.retryCommentLeadsOnly,
  );
  const leadsRetryRecords = preparedRecordsToSync.filter(
    (record) => record.retryCommentLeadsOnly,
  );
  const syncGroups = buildWorkflowSyncGroups(contentRecordsToSync);
  let processedCount = 0;
  let syncPaused = null;
  let syncCanceled = false;

  await updateSync({
    status: SYNC_STATUS.SYNCING,
    lastAttemptedAt: new Date().toISOString(),
  });

  if (onProgress) {
    onProgress({
      phase: 'batch_prepare',
      current: 0,
      total: recordIdsToSync.length,
      message: `正在准备批量同步 ${recordIdsToSync.length} 条记录...`,
    });
  }

  // 先将所有待同步记录标记为草稿态，避免遗留失败态影响 UI
  for (const record of preparedRecordsToSync) {
    await updateRecord(record.id, {
      status: RECORD_STATUS.DRAFT,
    });
  }

  if (onProgress) {
    onProgress({
      phase: 'batch_sync',
      current: 0,
      total: recordIdsToSync.length,
      message: `正在批量同步 ${recordIdsToSync.length} 条记录...`,
    });
  }

  // 处理找不到记录的情况
  recordIdsToSync.forEach((recordId) => {
    if (recordMap.has(recordId)) return;
    results.push({
      recordId,
      platform: 'unknown',
      type: null,
      workflow: '',
      noteType: null,
      success: false,
      reason: 'RECORD_NOT_FOUND',
      message: '记录不存在',
      debugUrl: null,
      rawResponse: null,
      error: { code: 'RECORD_NOT_FOUND', message: '记录不存在' },
    });
  });
  processedCount = results.length;

  for (let groupIndex = 0; groupIndex < syncGroups.length; groupIndex += 1) {
    if (isSyncCancellationRequested(shouldStop, signal)) {
      syncCanceled = true;
      break;
    }
    const group = syncGroups[groupIndex];
    if (!Array.isArray(group.records) || group.records.length === 0) {
      continue;
    }

    const groupStartedAt = Date.now();
    const groupResults = await syncGroupRecordsWithRetry({
      group,
      requestTarget,
      onProgress,
      completedOffset: processedCount,
      totalCount: recordIdsToSync.length,
      requestSpacingMs: options?.requestSpacingMs,
      rateLimitBaseDelayMs: options?.rateLimitBaseDelayMs,
      rateLimitMaxDelayMs: options?.rateLimitMaxDelayMs,
      rateLimitRetryAttempts: options?.rateLimitRetryAttempts,
      shouldStop,
      signal,
    });
    const groupSyncDiagnostics =
      groupResults?.syncDiagnostics && typeof groupResults.syncDiagnostics === 'object'
        ? groupResults.syncDiagnostics
        : null;
    let groupPaused =
      groupResults?.syncPaused && typeof groupResults.syncPaused === 'object'
        ? groupResults.syncPaused
        : null;

    results.push(...groupResults);
    processedCount += groupResults.length;
    if (groupResults?.syncCanceled === true) {
      syncCanceled = true;
    }
    if (groupPaused) {
      const shouldBlockRemainingGroups = groupPaused.blocking !== false;
      groupPaused = extendSyncPausedMetadata(
        groupPaused,
        shouldBlockRemainingGroups
          ? syncGroups
              .slice(groupIndex + 1)
              .flatMap((nextGroup) =>
                Array.isArray(nextGroup?.records) ? nextGroup.records : [],
              )
          : [],
        {
          confirmedSuccessCount: results.filter((result) => result.success).length,
        },
      );
    }

    await addSyncHistoryEntry({
      trigger: options.trigger || 'manual',
      syncScope: options.syncScope || 'pending',
      startedAt: groupStartedAt,
      finishedAt: Date.now(),
      totalCount: group.records.length,
      requestedTotalCount: group.records.length,
      skippedCount: 0,
      successCount: groupResults.filter((result) => result.success).length,
      failedCount: groupResults.filter((result) => !result.success).length,
      debugUrl: pickBatchDebugUrl(groupResults) || null,
      platform: group.platform || 'unknown',
      syncType: group.syncType || '',
      workflow: group.workflow || '',
      target: buildSyncHistoryTarget(requestTarget, {
        platform: group.platform || 'unknown',
        syncType: group.syncType || '',
        workflow: group.workflow || '',
      }),
      recordIds: group.records.map((record) => record.id),
      skippedRecordIds: [],
      items: groupResults,
      syncRequest: groupSyncDiagnostics,
      syncPaused: groupPaused,
      batchStartedAt: startedAt,
      batchRequestedTotalCount: requestedRecordIds.length,
      batchSyncedCount: recordIdsToSync.length,
      batchSkippedCount: skippedRecordIds.length,
    });

    if (syncCanceled) {
      break;
    }

    if (groupPaused) {
      syncPaused = mergeSyncPausedMetadata(syncPaused, groupPaused, {
        confirmedSuccessCount: results.filter((result) => result.success).length,
      });
      if (groupPaused.blocking !== false) {
        break;
      }
    }
  }

  let commentLeadsSyncedCount = 0;
  let commentLeadsSkippedCount = 0;
  let commentLeadsFailedCount = 0;
  const commentLeadsCanceledRecordIds = [];
  const commentLeadHistoryItems = [];
  const hasAnyStoredCommentLeads = preparedRecordsToSync.some((record) =>
    hasStoredCommentLeadsPayload(record.syncType, record.syncPayload),
  );

  if (commentLeadsConfig.enabled && leadsRetryRecords.length > 0) {
    for (const record of leadsRetryRecords) {
      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        break;
      }
      const debugUrl = normalizeDebugUrl(record?.lastSyncDebugUrl || '');
      results.push({
        recordId: record.id,
        platform: record.platform || 'unknown',
        type: record.syncType || record.type,
        sourceType: record.sourceType || record.type,
        workflow: record.workflow || '',
        noteType: getSingleNoteType(record.syncPayload || record.payload),
        success: true,
        reason: 'COMMENT_LEADS_RETRY_ONLY',
        message: '内容已同步，重试客资同步',
        debugUrl: debugUrl || null,
        rawResponse: null,
        error: null,
      });
      processedCount += 1;
      if (onProgress) {
        onProgress({
          phase: 'batch_sync',
          current: processedCount,
          total: recordIdsToSync.length,
          message: `正在处理第 ${processedCount}/${recordIdsToSync.length} 条记录...`,
          recordId: record.id,
        });
      }
    }
  }

  if (
    !syncCanceled &&
    !syncPaused &&
    (commentLeadsConfig.enabled || hasAnyStoredCommentLeads)
  ) {
    const resultByRecordId = new Map(
      results.map((item) => [String(item?.recordId || ''), item]),
    );
    const eligibleRecords = preparedRecordsToSync.filter((record) => {
      if (!isCommentLeadsEligibleSyncType(record.syncType)) return false;
      const current = resultByRecordId.get(record.id);
      if (!current?.success) return false;
      return (
        commentLeadsConfig.enabled ||
        hasStoredCommentLeadsPayload(record.syncType, record.syncPayload)
      );
    });

    const markCommentLeadsCanceled = async (records = []) => {
      for (const pendingRecord of records) {
        if (!pendingRecord?.id) continue;
        if (!commentLeadsCanceledRecordIds.includes(pendingRecord.id)) {
          commentLeadsCanceledRecordIds.push(pendingRecord.id);
        }
        await updateRecord(pendingRecord.id, {
          status: RECORD_STATUS.FAILED,
          lastSyncedAt: Date.now(),
          lastSyncReason: 'COMMENT_LEADS_SYNC_CANCELED',
        });
      }
    };

    for (let eligibleIndex = 0; eligibleIndex < eligibleRecords.length; eligibleIndex += 1) {
      const record = eligibleRecords[eligibleIndex];
      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        await markCommentLeadsCanceled(eligibleRecords.slice(eligibleIndex));
        break;
      }
      const existingResult = resultByRecordId.get(record.id);
      const leadResult = buildCommentLeadsPayloadForRecord(
        {
          type: record.syncType,
          payload: record.syncPayload,
        },
        commentLeadsConfig,
        { preferStored: true },
      );
      const latestRecord = (await getRecord(record.id)) || record;
      const basePayload =
        latestRecord?.payload && typeof latestRecord.payload === 'object'
          ? latestRecord.payload
          : {};
      const canSyncStoredLeads = leadResult.source === 'stored' && Boolean(leadResult.payload);

      if (leadResult.skipReason || !leadResult.payload) {
        commentLeadsSkippedCount += 1;
        const nextPayload = applyCommentLeadsSyncState(basePayload, {
          config: commentLeadsConfig,
          leadResult,
          syncStatus:
            leadResult.skipReason === 'disabled' ? 'not_started' : 'skipped',
          syncError: '',
        });
        await updateRecord(record.id, {
          payload: nextPayload,
        });
        if (record.retryCommentLeadsOnly) {
          await markRecordSynced(record.id, existingResult?.debugUrl || null);
          if (existingResult) {
            existingResult.reason = ERROR_REASON.NONE;
            existingResult.message = `客资已跳过（${leadResult.skipReason || 'skip'}）`;
          }
        }
        commentLeadHistoryItems.push({
          recordId: record.id,
          type: SYNC_TYPE.COMMENT_LEADS,
          platform: record.platform || 'unknown',
          sourceType: record.sourceType || record.type,
          workflow: 'shared_comment_leads',
          noteType: null,
          success: true,
          reason:
            leadResult.skipReason === 'disabled'
              ? 'COMMENT_LEADS_NOT_STARTED'
              : 'COMMENT_LEADS_SKIPPED',
          message:
            leadResult.skipReason === 'disabled'
              ? '客资同步未开启'
              : `客资已跳过（${leadResult.skipReason || 'skip'}）`,
          debugUrl: null,
          rawResponse: null,
          error: null,
        });
        continue;
      }

      const leadSyncResult = await sync(
        {
          syncType: SYNC_TYPE.COMMENT_LEADS,
          target: requestTarget,
          payload: leadResult.payload,
        },
        {shouldStop, signal},
      );
      if (leadSyncResult?.canceled) {
        syncCanceled = true;
        await markCommentLeadsCanceled(eligibleRecords.slice(eligibleIndex));
        break;
      }
      const leadsDebugUrl = extractDebugUrl(leadSyncResult);
      if (leadSyncResult.ok) {
        commentLeadsSyncedCount += 1;
        const nextPayload = applyCommentLeadsSyncState(basePayload, {
          config: commentLeadsConfig,
          leadResult,
          syncStatus: 'done',
          syncError: '',
        });
        await updateRecord(record.id, {
          payload: nextPayload,
        });
        if (record.retryCommentLeadsOnly) {
          await markRecordSynced(
            record.id,
            leadsDebugUrl || existingResult?.debugUrl || null,
          );
          if (existingResult) {
            existingResult.reason = ERROR_REASON.NONE;
            existingResult.message = '客资同步成功';
            existingResult.debugUrl =
              leadsDebugUrl || existingResult.debugUrl || null;
            existingResult.rawResponse = {
              content: existingResult.rawResponse,
              commentLeads: leadSyncResult,
            };
          }
        }
        commentLeadHistoryItems.push({
          recordId: record.id,
          type: SYNC_TYPE.COMMENT_LEADS,
          platform: record.platform || 'unknown',
          sourceType: record.sourceType || record.type,
          workflow: 'shared_comment_leads',
          noteType: null,
          success: true,
          reason: ERROR_REASON.NONE,
          message: canSyncStoredLeads ? '客资同步成功（使用已命中结果）' : '客资同步成功',
          debugUrl: leadsDebugUrl || null,
          rawResponse: leadSyncResult,
          error: null,
        });
        continue;
      }

      commentLeadsFailedCount += 1;
      const failedMessage =
        leadSyncResult.error?.message ||
        leadSyncResult.message ||
        '客资同步失败';
      const nextPayload = applyCommentLeadsSyncState(basePayload, {
        config: commentLeadsConfig,
        leadResult,
        syncStatus: 'failed',
        syncError: failedMessage,
      });
      await updateRecord(record.id, {
        status: RECORD_STATUS.FAILED,
        lastSyncedAt: Date.now(),
        lastSyncReason: 'COMMENT_LEADS_SYNC_FAILED',
        lastSyncDebugUrl: leadsDebugUrl || null,
        payload: nextPayload,
      });
      if (existingResult) {
        existingResult.success = false;
        existingResult.reason = 'COMMENT_LEADS_SYNC_FAILED';
        existingResult.message = '内容表已同步，客资表同步失败';
        existingResult.debugUrl = leadsDebugUrl || existingResult.debugUrl || null;
        existingResult.error = {
          code: 'COMMENT_LEADS_SYNC_FAILED',
          message: failedMessage,
        };
        existingResult.rawResponse = {
          content: existingResult.rawResponse,
          commentLeads: leadSyncResult,
        };
      }
      commentLeadHistoryItems.push({
        recordId: record.id,
        type: SYNC_TYPE.COMMENT_LEADS,
        platform: record.platform || 'unknown',
        sourceType: record.sourceType || record.type,
        workflow: 'shared_comment_leads',
        noteType: null,
        success: false,
        reason: 'COMMENT_LEADS_SYNC_FAILED',
        message: failedMessage,
        debugUrl: leadsDebugUrl || null,
        rawResponse: leadSyncResult,
        error: {
          code: 'COMMENT_LEADS_SYNC_FAILED',
          message: failedMessage,
        },
      });
    }

    if (commentLeadHistoryItems.length > 0) {
      const commentLeadPlatforms = [
        ...new Set(commentLeadHistoryItems.map((item) => item.platform || 'unknown')),
      ];
      await addSyncHistoryEntry({
        trigger: options.trigger || 'manual',
        syncScope: options.syncScope || 'pending',
        startedAt,
        finishedAt: Date.now(),
        totalCount: commentLeadHistoryItems.length,
        requestedTotalCount: requestedRecordIds.length,
        skippedCount: commentLeadsSkippedCount,
        successCount: commentLeadHistoryItems.filter((item) => item.success).length,
        failedCount: commentLeadHistoryItems.filter((item) => !item.success).length,
        debugUrl: pickBatchDebugUrl(commentLeadHistoryItems) || null,
        platform:
          commentLeadPlatforms.length === 1
            ? commentLeadPlatforms[0]
            : 'mixed',
        syncType: SYNC_TYPE.COMMENT_LEADS,
        workflow: 'shared_comment_leads',
        target: buildSyncHistoryTarget(requestTarget, {
          platform:
            commentLeadPlatforms.length === 1
              ? commentLeadPlatforms[0]
              : 'mixed',
          syncType: SYNC_TYPE.COMMENT_LEADS,
          workflow: 'shared_comment_leads',
        }),
        recordIds: commentLeadHistoryItems.map((item) => item.recordId),
        skippedRecordIds: [],
        items: commentLeadHistoryItems,
        batchStartedAt: startedAt,
        batchRequestedTotalCount: requestedRecordIds.length,
        batchSyncedCount: recordIdsToSync.length,
        batchSkippedCount: skippedRecordIds.length,
      });
    }
  }

  if (syncCanceled || isSyncCancellationRequested(shouldStop, signal)) {
    await resetCanceledSyncState();
    if (onProgress) {
      onProgress({
        phase: 'sync_canceled',
        message: '任务已取消，未继续同步',
      });
    }
    return buildCanceledBatchSyncResult({
      requestedRecordIds,
      recordIdsToSync,
      skippedRecordIds,
      results,
      commentLeadsSyncedCount,
      commentLeadsSkippedCount,
      commentLeadsFailedCount,
      commentLeadsCanceledRecordIds,
    });
  }

  // 统计结果
  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter(
    (r) => r.success !== true && r.reason !== 'SYNC_BATCH_PAUSED',
  ).length;
  const pausedCount = Number(syncPaused?.pausedCount || 0);

  if (failedCount === 0 && pausedCount === 0) {
    await updateSync({
      status: SYNC_STATUS.SUCCESS,
      lastSyncedAt: new Date().toISOString(),
      error: null,
    });
  } else if (pausedCount > 0) {
    await updateSync({
      status: SYNC_STATUS.FAILED,
      error: {
        code: 'BATCH_SYNC_PAUSED',
        message:
          syncPaused?.message ||
          `同步已暂停：已确认成功 ${successCount} 条，剩余 ${pausedCount} 条待继续`,
      },
    });
  } else {
    await updateSync({
      status: SYNC_STATUS.FAILED,
      error: {
        code: 'BATCH_SYNC_PARTIAL_FAILURE',
        message: `${failedCount} 条记录同步失败`,
      },
    });
  }

  if (onProgress) {
    onProgress({
      phase: 'batch_done',
      message:
        pausedCount > 0
          ? `批量同步已暂停：成功 ${successCount}，待继续 ${pausedCount}`
          : `批量同步完成：成功 ${successCount}，失败 ${failedCount}`,
      successCount,
      failedCount,
      pausedCount,
    });
  }

  if (syncGroups.length === 0 && results.length > 0) {
    await addSyncHistoryEntry({
      trigger: options.trigger || 'manual',
      syncScope: options.syncScope || 'pending',
      startedAt,
      finishedAt: Date.now(),
      totalCount: results.length,
      requestedTotalCount: requestedRecordIds.length,
      skippedCount: skippedRecordIds.length,
      successCount,
      failedCount,
      debugUrl: pickBatchDebugUrl(results) || null,
      platform: 'unknown',
      syncType: '',
      workflow: 'shared_unknown',
      target: buildSyncHistoryTarget(requestTarget, {
        platform: 'unknown',
        syncType: '',
        workflow: 'shared_unknown',
      }),
      recordIds: [...recordIdsToSync],
      skippedRecordIds: [...skippedRecordIds],
      items: results,
    });
  }

  trackSyncSuccess(successCount, {
    source: 'batch_record_sync',
    requestedCount: requestedRecordIds.length,
    failedCount,
  });

  return {
    ok: failedCount === 0 && pausedCount === 0,
    results,
    successCount,
    failedCount,
    pausedCount,
    pausedRecordIds: Array.isArray(syncPaused?.pausedRecordIds)
      ? syncPaused.pausedRecordIds
      : [],
    pausedReason: syncPaused?.reason || '',
    pausedMessage: syncPaused?.message || '',
    requestedCount: requestedRecordIds.length,
    syncedCount: recordIdsToSync.length,
    skippedCount: skippedRecordIds.length,
    commentLeadsSyncedCount,
    commentLeadsSkippedCount,
    commentLeadsFailedCount,
  };
}

async function syncGroupRecordsWithRetry({
  group,
  requestTarget,
  onProgress = null,
  completedOffset = 0,
  totalCount = 0,
  requestSpacingMs,
  rateLimitBaseDelayMs,
  rateLimitMaxDelayMs,
  rateLimitRetryAttempts,
  shouldStop = null,
  signal = null,
} = {}) {
  const groupRecords = Array.isArray(group?.records) ? group.records : [];
  const queue = chunkSyncRecordsForRequest(groupRecords).map((records) => ({
    records,
  }));
  const normalizedRequestSpacingMs = normalizeSyncDelayMs(
    requestSpacingMs,
    SYNC_BATCH_REQUEST_SPACING_MS,
  );
  const normalizedRateLimitBaseDelayMs = normalizeSyncDelayMs(
    rateLimitBaseDelayMs,
    SYNC_RATE_LIMIT_RETRY_BASE_DELAY_MS,
  );
  const normalizedRateLimitMaxDelayMs = normalizeSyncDelayMs(
    rateLimitMaxDelayMs,
    SYNC_RATE_LIMIT_RETRY_MAX_DELAY_MS,
  );
  const normalizedRateLimitRetryAttempts = normalizeSyncAttemptCount(
    rateLimitRetryAttempts,
    SYNC_RATE_LIMIT_RETRY_ATTEMPTS,
  );
  const syncDiagnostics = {
    maxRecordsPerRequest: MAX_SYNC_RECORDS_PER_REQUEST,
    maxPayloadBytesPerRequest: MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
    maxCommentRichRecordsPerRequest: MAX_SYNC_COMMENT_RICH_RECORDS_PER_REQUEST,
    largeRecordBytesPerRequest: SYNC_LARGE_RECORD_BYTES_PER_REQUEST,
    commentRichRecordCount: groupRecords.filter(isCommentRichSyncRecord).length,
    requestSpacingMs: normalizedRequestSpacingMs,
    initialChunkSizes: queue.map((item) => item.records.length),
    requestCount: 0,
    chunkSizes: [],
    rateLimitRetryCount: 0,
    rateLimitRetryDelaysMs: [],
    paused: false,
    pausedReason: '',
    pausedCount: 0,
  };
  const groupResults = [];
  const nonBlockingPausedRecords = [];
  const nonBlockingPausedReasons = new Set();
  let requestIndex = 0;
  let lastRequestStartedAt = 0;
  let syncPaused = null;
  let syncCanceled = false;

  const emitProgress = (message, extra = {}) => {
    if (!onProgress) return;
    onProgress({
      phase: 'batch_sync',
      current: completedOffset + groupResults.length,
      total: totalCount,
      message,
      ...extra,
    });
  };

  while (queue.length > 0) {
    if (isSyncCancellationRequested(shouldStop, signal)) {
      syncCanceled = true;
      break;
    }
    if (syncPaused) {
      break;
    }

    const work = queue.shift();
    const chunkRecords = Array.isArray(work?.records)
      ? work.records.filter(Boolean)
      : [];

    if (chunkRecords.length === 0) {
      continue;
    }

    requestIndex += 1;
    const plannedRequestCount = requestIndex + queue.length;
    emitProgress(
      plannedRequestCount > 1
        ? `正在同步第 ${requestIndex}/${plannedRequestCount} 组...`
        : `正在批量同步 ${chunkRecords.length} 条记录...`,
    );

    let batchResult = null;
    for (let attempt = 0; attempt <= normalizedRateLimitRetryAttempts; attempt += 1) {
      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        break;
      }
      if (lastRequestStartedAt > 0) {
        const waitCompleted = await waitForSyncRequestSlot(
          lastRequestStartedAt,
          normalizedRequestSpacingMs,
          shouldStop,
          signal,
        );
        if (!waitCompleted) {
          syncCanceled = true;
          break;
        }
      }

      if (isSyncCancellationRequested(shouldStop, signal)) {
        syncCanceled = true;
        break;
      }
      lastRequestStartedAt = Date.now();
      syncDiagnostics.requestCount += 1;
      syncDiagnostics.chunkSizes.push(chunkRecords.length);
      batchResult = await runSyncBatchRequest(
        chunkRecords,
        requestTarget,
        shouldStop,
        signal,
      );
      if (batchResult?.canceled) {
        syncCanceled = true;
        break;
      }

      const attemptItems = getSyncBatchItems(batchResult);
      const allItemsRateLimited =
        attemptItems.length > 0 &&
        attemptItems.every(
          (item) => item?.ok !== true && isRateLimitedSyncItem(item, batchResult),
        );
      if (!isRateLimitedBatchResult(batchResult) && !allItemsRateLimited) {
        break;
      }

      if (attempt >= normalizedRateLimitRetryAttempts) {
        break;
      }

      const delayMs = resolveRateLimitRetryDelayMs(batchResult, attempt, {
        baseDelayMs: normalizedRateLimitBaseDelayMs,
        maxDelayMs: normalizedRateLimitMaxDelayMs,
      });
      syncDiagnostics.rateLimitRetryCount += 1;
      syncDiagnostics.rateLimitRetryDelaysMs.push(delayMs);
      emitProgress(
        `同步接口触发限流，${Math.ceil(delayMs / 1000)} 秒后重试当前 ${chunkRecords.length} 条...`,
      );
      const retryWaitCompleted = await waitForCancelableSyncDelay(
        delayMs,
        shouldStop,
        signal,
      );
      if (!retryWaitCompleted) {
        syncCanceled = true;
        break;
      }
    }

    if (syncCanceled) break;

    const batchItems = getSyncBatchItems(batchResult);
    const batchItemMap = new Map(
      batchItems
        .filter((item) => item && typeof item === 'object' && item.recordId)
        .map((item) => [item.recordId, item]),
    );

    if (isRateLimitedBatchResult(batchResult)) {
      const pausedRecords = [
        ...nonBlockingPausedRecords,
        ...chunkRecords,
        ...collectQueuedSyncRecords(queue),
      ];
      syncPaused = buildSyncPausedMetadata({
        reason: 'rate_limited',
        message: `同步接口触发限流，已确认成功 ${groupResults.length} 条，剩余 ${pausedRecords.length} 条待稍后继续`,
        pausedRecords,
        batchResult,
        blocking: true,
      });
      break;
    }

    if (batchItems.length === 0 && isIndeterminateBatchResult(batchResult)) {
      if (canContinueAfterIsolatedSyncPause(chunkRecords)) {
        nonBlockingPausedRecords.push(...chunkRecords);
        nonBlockingPausedReasons.add(
          normalizeBatchFailureReason(batchResult) || 'sync_result_unknown',
        );
        emitProgress(
          `当前记录同步超时，已保留待继续，正在尝试后续记录...`,
        );
        continue;
      }

      const pausedRecords = [
        ...nonBlockingPausedRecords,
        ...chunkRecords,
        ...collectQueuedSyncRecords(queue),
      ];
      syncPaused = buildSyncPausedMetadata({
        reason: normalizeBatchFailureReason(batchResult) || 'sync_result_unknown',
        message: `同步请求超时或中断，已确认成功 ${groupResults.length} 条，剩余 ${pausedRecords.length} 条待继续`,
        pausedRecords,
        batchResult,
        blocking: true,
      });
      break;
    }

    const pausedRecords = [];
    const finalResults = [];

    for (const record of chunkRecords) {
      const item = batchItemMap.get(record.id);
      const resultItem = buildSyncRecordResultItem(record, item, batchResult);

      if (!resultItem.success && isRateLimitedSyncItem(item, batchResult)) {
        pausedRecords.push(record);
        continue;
      }

      if (!resultItem.success && isIndeterminateSyncItem(item, batchResult)) {
        pausedRecords.push(record);
        continue;
      }

      finalResults.push(resultItem);
    }

    for (const resultItem of finalResults) {
      await applySyncRecordResultItem(resultItem);
      groupResults.push(resultItem);

      emitProgress(`正在处理第 ${completedOffset + groupResults.length}/${totalCount} 条记录...`, {
        recordId: resultItem.recordId,
      });
    }

    if (pausedRecords.length > 0) {
      if (canContinueAfterIsolatedSyncPause(pausedRecords)) {
        nonBlockingPausedRecords.push(...pausedRecords);
        const firstPausedItem = pausedRecords
          .map((record) => batchItemMap.get(record.id))
          .find(Boolean);
        nonBlockingPausedReasons.add(
          normalizeSyncItemFailureReason(firstPausedItem, batchResult) ||
            'sync_result_unknown',
        );
        emitProgress(
          `当前记录同步结果未知，已保留待继续，正在尝试后续记录...`,
        );
        continue;
      }

      const remainingRecords = [...pausedRecords, ...collectQueuedSyncRecords(queue)];
      const firstPausedItem = pausedRecords
        .map((record) => batchItemMap.get(record.id))
        .find(Boolean);
      const pauseReason = isRateLimitedSyncItem(firstPausedItem, batchResult)
        ? 'rate_limited'
        : normalizeSyncItemFailureReason(firstPausedItem, batchResult) ||
          'sync_result_unknown';
      syncPaused = buildSyncPausedMetadata({
        reason: pauseReason,
        message:
          pauseReason === 'rate_limited'
            ? `同步接口触发限流，已确认成功 ${groupResults.length} 条，剩余 ${remainingRecords.length} 条待稍后继续`
            : `同步请求超时或结果未知，已确认成功 ${groupResults.length} 条，剩余 ${remainingRecords.length} 条待继续`,
        pausedRecords: remainingRecords,
        batchResult,
        blocking: true,
      });
      break;
    }
  }

  if (!syncPaused && nonBlockingPausedRecords.length > 0) {
    const pausedCount = Array.from(
      new Set(nonBlockingPausedRecords.map((record) => record?.id).filter(Boolean)),
    ).length;
    const primaryReason =
      Array.from(nonBlockingPausedReasons).find(Boolean) || 'sync_result_unknown';
    syncPaused = buildSyncPausedMetadata({
      reason: primaryReason,
      message: `部分记录同步超时或结果未知，已确认成功 ${groupResults.length} 条，剩余 ${pausedCount} 条待继续`,
      pausedRecords: nonBlockingPausedRecords,
      batchResult: null,
      blocking: false,
    });
  }

  if (syncPaused) {
    syncDiagnostics.paused = true;
    syncDiagnostics.pausedReason = syncPaused.reason;
    syncDiagnostics.pausedCount = syncPaused.pausedCount;
    syncDiagnostics.pausedBlocking = syncPaused.blocking !== false;
  }
  if (syncCanceled) {
    syncDiagnostics.canceled = true;
  }

  Object.defineProperty(groupResults, 'syncDiagnostics', {
    value: syncDiagnostics,
    enumerable: false,
  });
  if (syncPaused) {
    Object.defineProperty(groupResults, 'syncPaused', {
      value: syncPaused,
      enumerable: false,
    });
  }
  if (syncCanceled) {
    Object.defineProperty(groupResults, 'syncCanceled', {
      value: true,
      enumerable: false,
    });
  }
  return groupResults;
}

async function runSyncBatchRequest(
  records,
  requestTarget,
  shouldStop = null,
  signal = null,
) {
  try {
    return await syncBatch(
      records.map(buildSyncBatchRecordInput),
      requestTarget,
      {shouldStop, signal},
    );
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      reason: ERROR_REASON.NETWORK_ERROR,
      message: error?.message || 'Network error',
      error: {
        reason: ERROR_REASON.NETWORK_ERROR,
        message: error?.message || 'Network error',
      },
      data: null,
    };
  }
}

function buildSyncBatchRecordInput(record) {
  const syncType = record.syncType || record.type;
  return {
    id: record.id,
    type: syncType,
    platform: record.platform || '',
    workflow: record.workflow || '',
    monitorExecutionId: record.monitorExecutionId || '',
    captureTaskId: record.captureTaskId || '',
    captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
    captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
    payload: buildSyncRequestPayload(syncType, record.syncPayload || record.payload),
  };
}

function buildSyncBatchRecordRequestShape(record) {
  const syncType = record.syncType || record.type;
  return {
    recordId: record.id,
    syncType,
    platform: record.platform || '',
    workflow: record.workflow || '',
    monitorExecutionId: record.monitorExecutionId || '',
    captureTaskId: record.captureTaskId || '',
    captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
    captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
    payload: buildSyncRequestPayload(syncType, record.syncPayload || record.payload),
  };
}

function buildSyncRequestPayload(syncType, payload) {
  const normalizedType = String(syncType || '').trim();
  if (
    normalizedType === SYNC_TYPE.COMMENTS ||
    normalizedType === SYNC_TYPE.COMMENT_LEADS
  ) {
    return payload;
  }
  // 内容同步必须【原样发送】，不剔除结构化评论。
  // 当前没有独立的评论同步通道，服务端通过内容同步包里的 commentsCleanedItems 入库。
  // record_comments → 评论分诊/销售客资/评论时间。若通过
  // stripCommentCollectionsForContentSync 剔除评论数组，会导致关键词笔记采集
  // 的评论只剩合并文本、进不了表（列表能看到，但弹窗/分诊/客资全空），故此处不剔除。
  return payload;
}

function stripCommentCollectionsForContentSync(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => stripCommentCollectionsForContentSync(item, seen));
  }

  const result = {};
  Object.entries(value).forEach(([key, nestedValue]) => {
    const isCommentCollection =
      key === 'commentsCleanedItems' ||
      key === 'commentsItems' ||
      key === 'commentItems' ||
      key === 'commentLeadsItems' ||
      (key === 'comments' && Array.isArray(nestedValue));
    if (isCommentCollection) {
      return;
    }
    result[key] = stripCommentCollectionsForContentSync(nestedValue, seen);
  });
  return result;
}

function buildSyncRecordResultItem(record, item, batchResult) {
  const debugUrl =
    normalizeDebugUrl(item?.debugUrl) ||
    (batchResult?.ok ? extractDebugUrl(batchResult) : '');
  const success = item?.ok === true;
  const reason =
    item?.reason ||
    (success
      ? ERROR_REASON.NONE
      : batchResult?.reason ||
        batchResult?.error?.reason ||
        batchResult?.error?.code ||
        'SYNC_ERROR');
  const message =
    item?.message ||
    (success
      ? '同步成功'
      : batchResult?.message || batchResult?.error?.message || '同步失败');

  return {
    recordId: record.id,
    platform: record.platform || 'unknown',
    type: record.syncType || record.type,
    sourceType: record.sourceType || record.type,
    workflow: record.workflow || '',
    noteType:
      (record.syncType || record.type) === 'single_note'
        ? getSingleNoteType(record.syncPayload || record.payload)
        : null,
    success,
    reason,
    message,
    debugUrl: debugUrl || null,
    rawResponse: item?.rawResponse || batchResult,
    error: success
      ? null
      : {
          reason,
          message,
        },
  };
}

async function applySyncRecordResultItem(resultItem) {
  if (!resultItem?.recordId) return;

  if (resultItem.success) {
    await markRecordSynced(resultItem.recordId, resultItem.debugUrl || null);
    return;
  }

  await updateRecord(resultItem.recordId, {
    status: RECORD_STATUS.FAILED,
    lastSyncedAt: Date.now(),
    lastSyncReason: resultItem.reason,
    lastSyncDebugUrl: resultItem.debugUrl || null,
  });
}

function getSyncBatchItems(batchResult) {
  return Array.isArray(batchResult?.data?.items) ? batchResult.data.items : [];
}

function collectQueuedSyncRecords(queue = []) {
  return Array.isArray(queue)
    ? queue.flatMap((item) =>
        Array.isArray(item?.records) ? item.records.filter(Boolean) : [],
      )
    : [];
}

function buildSyncPausedMetadata({
  reason,
  message,
  pausedRecords = [],
  batchResult = null,
  blocking = true,
} = {}) {
  const pausedRecordIds = Array.from(
    new Set(
      (Array.isArray(pausedRecords) ? pausedRecords : [])
        .map((record) => String(record?.id || '').trim())
        .filter(Boolean),
    ),
  );

  return {
    reason: String(reason || 'sync_result_unknown').trim() || 'sync_result_unknown',
    message:
      String(message || '').trim() ||
      `同步已暂停，剩余 ${pausedRecordIds.length} 条待继续`,
    pausedCount: pausedRecordIds.length,
    pausedRecordIds,
    rawResponse: batchResult,
    blocking: blocking !== false,
  };
}

function extendSyncPausedMetadata(paused, additionalRecords = [], {
  confirmedSuccessCount = 0,
} = {}) {
  if (!paused || typeof paused !== 'object') {
    return paused;
  }
  const additionalRecordIds = (Array.isArray(additionalRecords) ? additionalRecords : [])
    .map((record) => String(record?.id || '').trim())
    .filter(Boolean);

  const pausedRecordIds = Array.from(
    new Set([
      ...(Array.isArray(paused.pausedRecordIds) ? paused.pausedRecordIds : []),
      ...additionalRecordIds,
    ]),
  );
  const reason = String(paused.reason || 'sync_result_unknown').trim();

  return {
    ...paused,
    pausedCount: pausedRecordIds.length,
    pausedRecordIds,
    message: formatSyncPausedMessage(reason, confirmedSuccessCount, pausedRecordIds.length),
  };
}

function mergeSyncPausedMetadata(current, next, {
  confirmedSuccessCount = 0,
} = {}) {
  if (!current || typeof current !== 'object') {
    return extendSyncPausedMetadata(next, [], { confirmedSuccessCount });
  }
  if (!next || typeof next !== 'object') {
    return extendSyncPausedMetadata(current, [], { confirmedSuccessCount });
  }

  const pausedRecordIds = Array.from(
    new Set([
      ...(Array.isArray(current.pausedRecordIds) ? current.pausedRecordIds : []),
      ...(Array.isArray(next.pausedRecordIds) ? next.pausedRecordIds : []),
    ]),
  );
  const reasons = [
    String(current.reason || '').trim(),
    String(next.reason || '').trim(),
  ].filter(Boolean);
  const reason = reasons.includes('rate_limited')
    ? 'rate_limited'
    : Array.from(new Set(reasons)).length === 1
      ? reasons[0]
      : 'sync_result_unknown';

  return {
    ...current,
    ...next,
    reason,
    blocking: current.blocking !== false || next.blocking !== false,
    pausedCount: pausedRecordIds.length,
    pausedRecordIds,
    rawResponse: next.rawResponse || current.rawResponse || null,
    message: formatSyncPausedMessage(reason, confirmedSuccessCount, pausedRecordIds.length),
  };
}

function formatSyncPausedMessage(reason, confirmedSuccessCount, pausedCount) {
  const isRateLimited = String(reason || '').trim() === 'rate_limited';
  return isRateLimited
    ? `同步接口触发限流，已确认成功 ${confirmedSuccessCount} 条，剩余 ${pausedCount} 条待稍后继续`
    : `同步请求超时或结果未知，已确认成功 ${confirmedSuccessCount} 条，剩余 ${pausedCount} 条待继续`;
}

function normalizeBatchFailureReason(batchResult) {
  return String(
    batchResult?.reason ||
      batchResult?.error?.reason ||
      batchResult?.error?.code ||
      batchResult?.data?.reason ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeBatchFailureMessage(batchResult) {
  return String(
    batchResult?.message ||
      batchResult?.error?.message ||
      batchResult?.data?.message ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeSyncItemFailureReason(item, batchResult) {
  return String(
    item?.reason ||
      item?.error?.reason ||
      item?.error?.code ||
      normalizeBatchFailureReason(batchResult) ||
      '',
  )
    .trim()
    .toLowerCase();
}

function normalizeSyncItemFailureMessage(item, batchResult) {
  return String(
    item?.message ||
      item?.error?.message ||
      normalizeBatchFailureMessage(batchResult) ||
      '',
  )
    .trim()
    .toLowerCase();
}

function isRateLimitedBatchResult(batchResult) {
  if (!batchResult || batchResult?.ok === true) {
    return false;
  }
  return isRateLimitedSyncReason(
    normalizeBatchFailureReason(batchResult),
    normalizeBatchFailureMessage(batchResult),
    batchResult?.error?.httpStatus || batchResult?.httpStatus,
  );
}

function isRateLimitedSyncItem(item, batchResult) {
  if (item?.ok === true) {
    return false;
  }
  return isRateLimitedSyncReason(
    normalizeSyncItemFailureReason(item, batchResult),
    normalizeSyncItemFailureMessage(item, batchResult),
    item?.httpStatus ||
      item?.error?.httpStatus ||
      batchResult?.error?.httpStatus ||
      batchResult?.httpStatus,
  );
}

function isRateLimitedSyncReason(reason, message = '', httpStatus = null) {
  if (Number(httpStatus) === 429) {
    return true;
  }
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason && RATE_LIMIT_SYNC_REASONS.has(normalizedReason)) {
    return true;
  }
  const searchable = `${normalizedReason} ${String(message || '').toLowerCase()}`;
  return /(^|\s)429(\s|$)|too many requests|rate limit|rate_limited/.test(searchable);
}

function isIndeterminateBatchResult(batchResult) {
  if (!batchResult || batchResult?.ok === true || isRateLimitedBatchResult(batchResult)) {
    return false;
  }
  return isIndeterminateSyncReason(
    normalizeBatchFailureReason(batchResult),
    normalizeBatchFailureMessage(batchResult),
  );
}

function isIndeterminateSyncItem(item, batchResult) {
  if (item?.ok === true || isRateLimitedSyncItem(item, batchResult)) {
    return false;
  }
  return isIndeterminateSyncReason(
    normalizeSyncItemFailureReason(item, batchResult),
    normalizeSyncItemFailureMessage(item, batchResult),
  );
}

function isIndeterminateSyncReason(reason, message = '') {
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason && INDETERMINATE_SYNC_REASONS.has(normalizedReason)) {
    return true;
  }

  const searchable = `${normalizedReason} ${String(message || '').toLowerCase()}`;
  return /timeout|timed out|abort|aborted|network|fetch failed/.test(searchable);
}

function normalizeSyncDelayMs(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return Math.max(0, Math.floor(Number(fallback) || 0));
}

function normalizeSyncAttemptCount(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return Math.max(0, Math.floor(Number(fallback) || 0));
}

function resolveRateLimitRetryDelayMs(batchResult, attempt, {
  baseDelayMs,
  maxDelayMs,
} = {}) {
  const explicitMs = Number(
    batchResult?.data?.retryAfterMs ||
      batchResult?.data?.retry_after_ms ||
      batchResult?.retryAfterMs,
  );
  if (Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.min(Math.floor(explicitMs), maxDelayMs);
  }

  const explicitSeconds = Number(
    batchResult?.data?.retryAfterSeconds ||
      batchResult?.data?.retry_after_seconds ||
      batchResult?.retryAfterSeconds,
  );
  if (Number.isFinite(explicitSeconds) && explicitSeconds > 0) {
    return Math.min(Math.floor(explicitSeconds * 1000), maxDelayMs);
  }

  const multiplier = 2 ** Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(Math.max(0, baseDelayMs) * multiplier, maxDelayMs);
}

function sleep(ms) {
  const delay = Math.max(0, Math.floor(Number(ms) || 0));
  if (delay <= 0) {
    return Promise.resolve();
  }
  // 走可靠时钟(Worker),后台标签页里不被 Chrome 节流;见 waitMs 上方注释。
  return waitMs(delay);
}

async function waitForCancelableSyncDelay(
  delayMs,
  shouldStop = null,
  signal = null,
  pollMs = 100,
) {
  let remainingMs = Math.max(0, Math.floor(Number(delayMs) || 0));
  const intervalMs = Math.max(25, Math.floor(Number(pollMs) || 100));
  while (remainingMs > 0) {
    if (isSyncCancellationRequested(shouldStop, signal)) return false;
    const currentDelayMs = Math.min(intervalMs, remainingMs);
    await sleep(currentDelayMs);
    remainingMs -= currentDelayMs;
  }
  return !isSyncCancellationRequested(shouldStop, signal);
}

async function waitForSyncRequestSlot(
  lastRequestStartedAt,
  spacingMs,
  shouldStop = null,
  signal = null,
) {
  const spacing = Math.max(0, Math.floor(Number(spacingMs) || 0));
  if (!lastRequestStartedAt || spacing <= 0) {
    return !isSyncCancellationRequested(shouldStop, signal);
  }
  const elapsedMs = Date.now() - lastRequestStartedAt;
  if (elapsedMs >= spacing) {
    return !isSyncCancellationRequested(shouldStop, signal);
  }
  return await waitForCancelableSyncDelay(
    spacing - elapsedMs,
    shouldStop,
    signal,
  );
}

function canContinueAfterIsolatedSyncPause(records = []) {
  const safeRecords = (Array.isArray(records) ? records : []).filter(Boolean);
  return safeRecords.length === 1 && isIsolatedHeavySyncRecord(safeRecords[0]);
}

function isIsolatedHeavySyncRecord(record = {}) {
  if (!record || typeof record !== 'object') {
    return false;
  }
  if (isCommentRichSyncRecord(record)) {
    return true;
  }
  return (
    estimateJsonBytes(buildSyncBatchRecordRequestShape(record)) >=
    SYNC_LARGE_RECORD_BYTES_PER_REQUEST
  );
}

function chunkSyncRecordsForRequest(records = [], options = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const chunkOptions =
    typeof options === 'number' ? { maxRecords: options } : options || {};
  const maxRecords = Math.max(
    1,
    Math.floor(Number(chunkOptions.maxRecords || MAX_SYNC_RECORDS_PER_REQUEST)) || 1,
  );
  const maxPayloadBytes = Math.max(
    1,
    Math.floor(
      Number(
        chunkOptions.maxPayloadBytes || MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
      ),
    ) || MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST,
  );
  const chunks = [];
  let currentChunk = [];
  let currentBytes = 0;

  const flushCurrentChunk = () => {
    if (currentChunk.length === 0) return;
    chunks.push(currentChunk);
    currentChunk = [];
    currentBytes = 0;
  };

  for (const record of records) {
    const recordBytes = estimateJsonBytes(buildSyncBatchRecordRequestShape(record));
    if (isIsolatedHeavySyncRecord(record)) {
      flushCurrentChunk();
      currentChunk.push(record);
      currentBytes += recordBytes;
      flushCurrentChunk();
      continue;
    }

    const wouldExceedCount = currentChunk.length >= maxRecords;
    const wouldExceedBytes =
      currentChunk.length > 0 && currentBytes + recordBytes > maxPayloadBytes;

    if (wouldExceedCount || wouldExceedBytes) {
      flushCurrentChunk();
    }

    currentChunk.push(record);
    currentBytes += recordBytes;

    if (currentChunk.length >= maxRecords || currentBytes >= maxPayloadBytes) {
      flushCurrentChunk();
    }
  }

  flushCurrentChunk();
  return chunks;
}

function isCommentRichSyncRecord(record = {}) {
  const payload =
    record?.syncPayload && typeof record.syncPayload === 'object'
      ? record.syncPayload
      : record?.payload && typeof record.payload === 'object'
        ? record.payload
        : {};
  return countPayloadCommentItems(payload) >= SYNC_COMMENT_RICH_RECORD_MIN_COMMENTS;
}

function countPayloadCommentItems(value, seen = new Set()) {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  let count = 0;
  const candidates = [
    value.commentsCleanedItems,
    value.commentsItems,
    value.comments,
  ];
  candidates.forEach((candidate) => {
    if (Array.isArray(candidate)) {
      count += candidate.length;
    }
  });

  const mergedText = String(value.commentsMergedText || '').trim();
  if (mergedText) {
    count += 1;
  }

  const detailPayload =
    value.detailPayload && typeof value.detailPayload === 'object'
      ? value.detailPayload
      : null;
  if (detailPayload) {
    count += countPayloadCommentItems(detailPayload, seen);
  }

  if (Array.isArray(value.items)) {
    value.items.forEach((item) => {
      count += countPayloadCommentItems(item, seen);
    });
  }

  return count;
}

function estimateJsonBytes(value) {
  let text = '';
  try {
    text = JSON.stringify(value) || '';
  } catch {
    return MAX_SYNC_PAYLOAD_BYTES_PER_REQUEST + 1;
  }

  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }

  return text.length * 2;
}

function buildWorkflowSyncGroups(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  const orderedTypes = new Map([
    [SYNC_TYPE.BLOGGER_PROFILE, 0],
    [SYNC_TYPE.BLOGGER_NOTES, 1],
    [SYNC_TYPE.KEYWORD_NOTES, 2],
    [SYNC_TYPE.SINGLE_NOTE, 3],
    [SYNC_TYPE.COMMENTS, 4],
    [SYNC_TYPE.COMMENT_LEADS, 5],
  ]);
  const groupsByKey = new Map();

  records.forEach((record) => {
    const syncType = String(record?.syncType || record?.type || '').trim();
    const platform = String(record?.platform || 'unknown').trim() || 'unknown';
    const workflow = String(record?.workflow || '').trim();
    // For keyword_notes, include keyword in group key so each keyword gets its own
    // syncBatch call. This prevents rapid sequential Coze calls within a single request
    // from causing silent failures where only the first keyword's data is written to Feishu.
    const keywordSuffix =
      syncType === SYNC_TYPE.KEYWORD_NOTES
        ? `::kw:${String(
            record?.syncPayload?.keyword || record?.payload?.keyword || '',
          ).trim()}`
        : '';
    const key = `${platform}::${syncType}::${workflow}${keywordSuffix}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.records.push(record);
      return;
    }
    groupsByKey.set(key, {
      platform,
      syncType,
      workflow,
      records: [record],
    });
  });

  return Array.from(groupsByKey.values()).sort((left, right) => {
    const leftOrder = orderedTypes.has(left.syncType)
      ? orderedTypes.get(left.syncType)
      : Number.MAX_SAFE_INTEGER;
    const rightOrder = orderedTypes.has(right.syncType)
      ? orderedTypes.get(right.syncType)
      : Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    if (left.platform !== right.platform) {
      return left.platform.localeCompare(right.platform);
    }
    return left.workflow.localeCompare(right.workflow);
  });
}

function buildSyncBatchRecord(record) {
  return {
    id: record.id,
    type: record.syncType || record.type,
    platform: record.platform,
    workflow: record.workflow,
    monitorExecutionId: record.monitorExecutionId || '',
    captureTaskId: record.captureTaskId || '',
    captureTaskItemAttemptId: record.captureTaskItemAttemptId || '',
    captureTaskItemRequestHash: record.captureTaskItemRequestHash || '',
    payload: record.syncPayload || record.payload,
  };
}

function estimateSyncBatchRecordBytes(record) {
  try {
    return JSON.stringify(buildSyncBatchRecord(record)).length;
  } catch {
    return MAX_SYNC_REQUEST_PAYLOAD_BYTES;
  }
}

function getSingleNoteType(payload) {
  const normalized = String(payload?.noteType || payload?.type || '').trim().toLowerCase();
  if (normalized === 'video' || normalized === '视频') {
    return 'video';
  }
  if (
    normalized === 'image' ||
    normalized === 'img' ||
    normalized === '图文' ||
    normalized === 'normal'
  ) {
    return 'image';
  }

  if (
    payload?.videoUrl ||
    payload?.videoLink ||
    payload?.video_url ||
    payload?.playUrl ||
    payload?.play_url ||
    payload?.media?.videoUrl ||
    payload?.media?.playUrl ||
    (Array.isArray(payload?.videoUrls) && payload.videoUrls.length > 0) ||
    (Array.isArray(payload?.videoList) && payload.videoList.length > 0) ||
    (Array.isArray(payload?.videos) && payload.videos.length > 0)
  ) {
    return 'video';
  }

  return 'image';
}

function normalizeDebugUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }

  const trimmed = url.trim();
  return trimmed || '';
}

function pickBatchDebugUrl(results) {
  const failedWithDebug = results.find(
    (result) => !result?.success && normalizeDebugUrl(result?.debugUrl)
  );
  if (failedWithDebug?.debugUrl) {
    return normalizeDebugUrl(failedWithDebug.debugUrl);
  }

  const firstWithDebug = results.find((result) =>
    normalizeDebugUrl(result?.debugUrl)
  );
  if (firstWithDebug?.debugUrl) {
    return normalizeDebugUrl(firstWithDebug.debugUrl);
  }

  return '';
}

// ==================== M4-05: 同步前统一检查 ====================

/**
 * 同步前检查
 * @returns {Promise<Object>} 检查结果
 */
export async function checkBeforeSync(requiredSyncTypes = [], options = {}) {
  const onProgress =
    options && typeof options.onProgress === 'function' ? options.onProgress : null;
  try {
    if (onProgress) {
      onProgress({
        phase: 'sync_check',
        message: '正在校验授权与同步配置...',
      });
    }

    // 检查 1: 是否已鉴权
    const auth = await getAuth();

    if (!auth.verified) {
      return {
        ok: false,
        error: {
          code: ERROR_REASON.NOT_VERIFIED,
          message:
            '当前功能需要激活码授权，已有激活码请在设置中完成验证；还没有可联系管理员获取。',
        },
      };
    }

    if (!auth.code) {
      return {
        ok: false,
        error: {
          code: ERROR_REASON.NOT_VERIFIED,
          message: '激活码缺失，请重新鉴权',
        },
      };
    }

    // 检查 2: 是否已配置目标
    const target = await getTarget();
    const requestTarget = buildSyncTargetPayload(target);

    // 使用 StarVoice 后台同步，不再强制要求 feishuAppToken
    // 如果配置了 feishuAppToken 则使用，否则使用激活码直连后端
    if (!requestTarget.feishuAppToken) {
      // 设置一个占位值，让后续逻辑不报错
      requestTarget.feishuAppToken = '__onstarvoice_backend__';
    }

    const syncTypesToCheck =
      Array.isArray(requiredSyncTypes) && requiredSyncTypes.length > 0
        ? [...new Set(requiredSyncTypes.filter(Boolean))]
        : DEFAULT_CHECK_SYNC_TYPES;

    const missingType = syncTypesToCheck.find(
      (syncType) => !resolveSyncTableName(requestTarget, syncType),
    );
    if (missingType) {
      const message =
        missingType === SYNC_TYPE.COMMENT_LEADS
          ? '请先配置评论客资同步表名'
          : missingType === SYNC_TYPE.SINGLE_NOTE ||
              missingType === SYNC_TYPE.COMMENTS ||
              missingType === SYNC_TYPE.KEYWORD_NOTES
          ? '请先配置单笔记/评论/关键词同步表名'
          : '请先配置博主页面同步的数据表名称';
      return {
        ok: false,
        error: {
          code: ERROR_REASON.INVALID_TARGET,
          message,
        },
      };
    }

    // 后端 sync/syncBatch 会在真正写入前再次校验激活码；这里不再额外
    // verify，避免每次同步前多唤醒一次 Neon。
    return {
      ok: true,
      error: null,
    };
  } catch (error) {
    console.error('[CaptureSync] Check before sync failed:', error);

    return {
      ok: false,
      error: {
        code: 'CHECK_FAILED',
        message: error.message,
      },
    };
  }
}

function buildSyncTargetPayload(target = {}) {
  return {
    feishuAppToken: String(target?.feishuAppToken || '').trim(),
    tableId: String(target?.tableId || '').trim(),
    keywordNotesTableName:
      String(target?.keywordNotesTableName || '').trim() ||
      DEFAULT_KEYWORD_NOTES_TABLE_NAME,
    bloggerProfileTableName:
      String(target?.bloggerProfileTableName || '').trim() ||
      DEFAULT_BLOGGER_PROFILE_TABLE_NAME,
    bloggerNotesTableName:
      String(target?.bloggerNotesTableName || '').trim() ||
      DEFAULT_BLOGGER_NOTES_TABLE_NAME,
    commentLeadsTableName:
      String(target?.commentLeadsTableName || '').trim() ||
      DEFAULT_COMMENT_LEADS_TABLE_NAME,
  };
}

// ==================== M4-06: 统一 syncType 调用封装 ====================

/**
 * 采集并同步 - 单篇笔记
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncSingleNote(onProgress = null) {
  return await captureAndSync({
    mode: 'single',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 博主信息
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncBloggerProfile(onProgress = null) {
  return await captureAndSync({
    mode: 'blogger_profile',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 博主笔记列表
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncBloggerNotes(onProgress = null) {
  return await captureAndSync({
    mode: 'blogger_notes',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 关键词搜索结果
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncKeywordNotes(onProgress = null) {
  return await captureAndSync({
    mode: 'keyword',
    onProgress,
    autoSync: true,
  });
}

/**
 * 采集并同步 - 评论
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>} 结果
 */
export async function captureAndSyncComments(onProgress = null) {
  return await captureAndSync({
    mode: 'comments',
    onProgress,
    autoSync: true,
  });
}

// ==================== 便捷函数 ====================

/**
 * 仅采集（不同步）
 * @param {Object} options - 配置选项
 * @returns {Promise<Object>} 结果
 */
export async function captureOnly(options = {}) {
  return await captureAndSync({
    ...options,
    autoSync: false,
  });
}

/**
 * 重置采集和同步状态
 */
export async function resetCaptureAndSyncState() {
  await resetCapture();
  await resetSync();
}

async function captureCommentsForSingleNoteRecord(
  recordId,
  {
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    commentsMaxItems = null,
    captureRequestId = '',
    runnerTabId = null,
    verifiedNoteId: providedVerifiedNoteId = '',
    onProgress = null,
  } = {},
) {
  const record = await getRecord(recordId);
  if (!record || record.type !== SYNC_TYPE.SINGLE_NOTE) {
    return {
      ok: false,
      phase: 'invalid_record',
      recordId,
      error: {
        code: 'RECORD_NOT_FOUND',
        message: '记录不存在或不是单篇笔记记录',
      },
    };
  }

  const settings = await getCaptureSettings();
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings({
    ...settings,
    enableCommentLeadsFilter:
      enableCommentLeadsFilter ?? settings.enableCommentLeadsFilter,
  });
  const maxDetectedItems = normalizeCommentsMaxDetectedItems(
    commentsMaxDetectedItems ?? commentsMaxItems,
    settings.commentsMaxDetectedItems,
  );
  const knownCommentsCount = resolveKnownCommentsCountForDetailCapture(
    record,
    record.payload,
  );
  if (knownCommentsCount === 0) {
    const confirmedAt = Date.now();
    let confirmedEmptyPayload = {
      ...applyCommentStatusToPayload(
        clearInterruptedCommentObservation(record.payload),
        createCommentStatusPatch({
          status: COMMENT_CAPTURE_STATUS.DONE,
          startedAt: confirmedAt,
          finishedAt: confirmedAt,
          stoppedByUser: false,
          error: '',
          cleanedItems: [],
          mergedText: '',
        }),
      ),
      commentsCaptureSkipReason: 'confirmed_zero',
    };
    confirmedEmptyPayload = applyCommentLeadsToPayload({
      syncType: SYNC_TYPE.SINGLE_NOTE,
      payload: confirmedEmptyPayload,
      commentLeadsConfig,
      computedAt: confirmedAt,
    }).payload;
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: confirmedEmptyPayload,
    });

    if (onProgress) {
      onProgress({
        phase: 'comments_done',
        message: '已确认评论数为 0，跳过评论区并进入下一条',
        recordId,
        collectedCount: 0,
        captureRequestId: String(captureRequestId || ''),
        runnerTabId:
          Number.isSafeInteger(Number(runnerTabId)) && Number(runnerTabId) > 0
            ? Number(runnerTabId)
            : null,
        captureAction: 'captureComments',
        stopReason: 'confirmed_zero',
      });
    }

    return {
      ok: true,
      phase: 'comments_done',
      recordId,
      captureRequestId: String(captureRequestId || ''),
      runnerTabId:
        Number.isSafeInteger(Number(runnerTabId)) && Number(runnerTabId) > 0
          ? Number(runnerTabId)
          : null,
      commentsCount: 0,
      currentObservedCount: 0,
      currentObservedItems: [],
      partial: false,
      stoppedByUser: false,
      stoppedByStall: false,
      stoppedByNetwork: false,
      stopReason: 'confirmed_zero',
      skipped: true,
      error: null,
    };
  }

  const commentCaptureIdentity = await ensureCommentCaptureIdentity({
    captureRequestId,
    runnerTabId,
    resolveRunnerTab: () => resolveCaptureTargetTab({mode: 'comments'}),
  });
  const expectedNoteId = resolveExpectedDouyinCommentNoteId(
    record,
    resolveRecordNoteUrl(record),
  );
  // Stored payloads are historical evidence and cannot prove which work is
  // currently open. Only an explicit verifier produced by the same live
  // navigation/capture call may bridge a transient blank DOM.
  const verifiedNoteId =
    extractDouyinDetailGuardItemId(providedVerifiedNoteId) === expectedNoteId
      ? expectedNoteId
      : '';
  const startedAt = Date.now();

  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: applyCommentStatusToPayload(
      clearInterruptedCommentObservation(record.payload),
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.CAPTURING,
        startedAt,
        finishedAt: 0,
        stoppedByUser: false,
        error: '',
      }),
    ),
  });

  if (onProgress) {
    onProgress({
      phase: 'comments_capturing',
      message: '评论采集中（0条）',
      recordId,
      collectedCount: 0,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      captureAction: 'captureComments',
    });
  }

  let commentsResult = null;
  try {
    commentsResult = await captureInTab(commentCaptureIdentity.runnerTabId, {
      mode: 'comments',
      captureParams: {
        captureRequestId: commentCaptureIdentity.captureRequestId,
        recordId,
        onlyLevel1: false,
        maxDetectedItems,
        maxDurationMs: settings.sharedMaxDurationMs,
        waitMinMs: settings.sharedWaitMinMs,
        waitMaxMs: settings.sharedWaitMaxMs,
        stallTimeoutMs: settings.sharedStallTimeoutMs,
        expectedNoteId,
        verifiedNoteId,
      },
    });
  } catch (error) {
    commentsResult = {
      ok: false,
      error: {
        code: String(error?.code || 'CAPTURE_FAILED'),
        message: error.message || '评论采集失败',
      },
    };
  }

  if (commentsResult?.ok) {
    const commentIdentityFailure = buildDouyinCommentIdentityFailure(
      expectedNoteId,
      resolveCapturedDouyinCommentNoteId(commentsResult),
    );
    if (commentIdentityFailure) {
      commentsResult = {
        ok: false,
        error: commentIdentityFailure,
      };
    }
  }

  if (!commentsResult.ok) {
    const latestRecord = await getRecord(recordId);
    const basePayload = clearInterruptedCommentObservation(
      latestRecord?.payload || record.payload,
    );
    const failedPayload = applyCommentStatusToPayload(
      basePayload,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.FAILED,
        startedAt,
        finishedAt: Date.now(),
        stoppedByUser: false,
        error: commentsResult.error?.message || '评论采集失败',
      }),
    );
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: failedPayload,
    });

    if (onProgress) {
      onProgress({
        phase: 'comments_failed',
        message: '评论采集失败，可点击重试',
        recordId,
        captureRequestId: commentCaptureIdentity.captureRequestId,
        runnerTabId: commentCaptureIdentity.runnerTabId,
        captureAction: 'captureComments',
        error: commentsResult.error || null,
      });
    }

    return {
      ok: false,
      phase: 'comments_failed',
      recordId,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      error: commentsResult.error || { code: 'CAPTURE_FAILED', message: '评论采集失败' },
    };
  }

  const rawItems = Array.isArray(commentsResult.data?.items) ? commentsResult.data.items : [];
  // Keep this run's bounded observation separate from the cumulative record
  // payload. Cloud patrols must never infer "new comments" from the merged
  // historical total.
  const currentObservedItems = cleanCommentsItems(rawItems);
  const existingItems = Array.isArray(record.payload?.commentsCleanedItems)
    ? record.payload.commentsCleanedItems
    : [];
  const effectiveMaxDetectedItems = resolveCommentMergeLimit(
    maxDetectedItems,
    existingItems.length,
  );
  const cleanedItems = cleanCommentsItems([
    ...existingItems,
    ...currentObservedItems,
  ]).slice(0, effectiveMaxDetectedItems);
  const isPartial =
    commentsResult.data?.captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL ||
    commentsResult.meta?.captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL;
  const stoppedByUser = Boolean(
    commentsResult.data?.stoppedByUser || commentsResult.meta?.stoppedByUser,
  );
  const stoppedByStall = Boolean(
    commentsResult.data?.stoppedByStall || commentsResult.meta?.stoppedByStall,
  );
  const stopReason = String(
    commentsResult.data?.stopReason ||
      commentsResult.meta?.scrollInfo?.stopReason ||
      '',
  );
  const stoppedByNetwork = stopReason === 'network_timeout';
  const partialMessage = isPartial
    ? commentCapturePartialMessage({
        stopReason,
        stoppedByUser,
        stoppedByStall,
        stoppedByNetwork,
        collectedCount: cleanedItems.length,
      })
    : '';
  const finalStatus = isPartial ? COMMENT_CAPTURE_STATUS.PARTIAL : COMMENT_CAPTURE_STATUS.DONE;
  const finishedAt = Date.now();
  const mergedText = buildCommentsMergedText(cleanedItems);
  const latestRecord = await getRecord(recordId);
  const basePayload = clearInterruptedCommentObservation(
    latestRecord?.payload || record.payload,
  );
  let mergedPayload = applyCommentStatusToPayload(
    basePayload,
    createCommentStatusPatch({
      status: finalStatus,
      startedAt,
      finishedAt,
      stoppedByUser,
      error: partialMessage,
      cleanedItems,
      mergedText,
    }),
  );
  mergedPayload = applyCommentLeadsToPayload({
    syncType: SYNC_TYPE.SINGLE_NOTE,
    payload: mergedPayload,
    commentLeadsConfig,
    computedAt: finishedAt,
  }).payload;

  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: mergedPayload,
  });

  if (onProgress) {
    onProgress({
      phase: isPartial ? 'comments_partial' : 'comments_done',
      message: isPartial
        ? partialMessage
        : `评论已合并（${cleanedItems.length}条）`,
      recordId,
      collectedCount: cleanedItems.length,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      captureAction: 'captureComments',
      stoppedByUser,
      stoppedByStall,
      stoppedByNetwork,
      stopReason,
    });
  }

  return {
    ok: true,
    phase: isPartial ? 'comments_partial' : 'comments_done',
    recordId,
    captureRequestId: commentCaptureIdentity.captureRequestId,
    runnerTabId: commentCaptureIdentity.runnerTabId,
    commentsCount: cleanedItems.length,
    currentObservedCount: currentObservedItems.length,
    currentObservedItems: currentObservedItems.slice(0, 20),
    partial: isPartial,
    stoppedByUser,
    stoppedByStall,
    stoppedByNetwork,
    stopReason,
    error: null,
  };
}

async function captureBloggerMetricsForSingleNoteRecord(
  recordId,
  {
    preferWorksTabForBloggerMetrics = null,
    detailNavTimeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    profileAfterNavWaitMs = PROFILE_AFTER_NAV_WAIT_MS,
    shouldStop = null,
    onProgress = null,
  } = {},
) {
  const record = await getRecord(recordId);
  if (!record || record.type !== SYNC_TYPE.SINGLE_NOTE) {
    return {
      ok: false,
      recordId,
      error: {
        code: 'RECORD_NOT_FOUND',
        message: '记录不存在或不是单篇笔记记录',
      },
    };
  }

  const basePayload = ensureBloggerMetricsFields(record.payload);
  const noteUrl =
    resolveRecordNoteUrl(record) ||
    normalizeOpenUrl(basePayload.url || basePayload.noteUrl);
  const platform = detectPlatformFromUrl(
    noteUrl || basePayload.authorUrl || basePayload.bloggerProfileUrl || '',
  );
  const directPatch = resolveBloggerMetricsPatchFromCurrentPayload(basePayload, {
    requireBothMetrics: platform === 'douyin',
  });
  const profileUrl = resolveBloggerProfileUrlFromPayload(basePayload);

  if (onProgress) {
    onProgress({
      phase: 'blogger_metrics_capturing',
      message: '正在准备采集博主粉丝数与获赞收藏...',
      recordId,
    });
  }

  let tab = null;
  let latestPayload = basePayload;
  try {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    tab = await getCurrentActiveTab();

    if (directPatch) {
      const donePayload = applyBloggerMetricsPatch(latestPayload, directPatch);
      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: donePayload,
      });
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_done',
          message: '已直接使用当前作品页的博主指标',
          recordId,
        });
      }
      return {
        ok: true,
        recordId,
        patch: directPatch,
        error: null,
      };
    }

    if (platform === 'douyin') {
      const shouldUseWorksTabForDouyinMetrics =
        typeof preferWorksTabForBloggerMetrics === 'boolean'
          ? preferWorksTabForBloggerMetrics
          : isDouyinContentFlowUrl(String(tab?.url || noteUrl || ''));

      if (!shouldUseWorksTabForDouyinMetrics) {
        throw new Error(
          '当前页面非内容流详情，按规则不切换TA的作品页，未能提取博主粉丝数与获赞收藏',
        );
      }

      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_extract_note',
          message: '正在进入TA的作品并提取博主粉丝数与获赞收藏...',
          recordId,
        });
      }

      const douyinMetricsResult = await captureDouyinBloggerMetricsFromNoteDetail({
        tabId: tab?.id,
        preferWorksTabForBloggerMetrics: shouldUseWorksTabForDouyinMetrics,
      });
      if (!douyinMetricsResult?.ok || !douyinMetricsResult.patch) {
        throw new Error(
          douyinMetricsResult?.error || '未能从TA的作品页解析博主粉丝数与获赞收藏',
        );
      }

      latestPayload = applyBloggerMetricsPatch(
        latestPayload,
        douyinMetricsResult.patch,
      );
      await updateRecord(recordId, {
        status: RECORD_STATUS.DRAFT,
        payload: latestPayload,
      });

      // 抖音号在博主主页上(作品页指标那条路拿不到)→ 补一次"导航到主页 + mode blogger_profile"(=douyin-blogger.js)取抖音号。
      // 失败不影响主流程(粉丝数已采到)。
      if (
        profileUrl &&
        tab?.id &&
        (typeof shouldStop !== 'function' || !shouldStop())
      ) {
        let profileNavigationAttempted = false;
        try {
          if (onProgress) {
            onProgress({
              phase: 'blogger_metrics_extract_douyin_id',
              message: '正在进入主页提取抖音号...',
              recordId,
            });
          }
          profileNavigationAttempted = true;
          await openUrlInTab(tab.id, profileUrl, {
            timeoutMs: detailNavTimeoutMs,
            shouldStop,
            active: true,
          });
          await waitMsWithStop(
            profileAfterNavWaitMs,
            shouldStop,
            'BATCH_CAPTURE_CANCELED',
          );
          const idResult = await captureInTab(tab.id, {
            mode: 'blogger_profile',
            captureParams: {},
          });
          // 真抖音号在 data.douyinId(extractDouyinId 取「抖音号:xxx」);
          // data.bloggerId 是 resolveBloggerId=URL 里的 sec_uid(MS4w...),不能用 —— 此前 bug 就在这。
          const douyinNo = idResult?.ok
            ? pickHumanAccountNo(idResult.data)
            : '';
          if (douyinNo) {
            latestPayload = applyBloggerMetricsPatch(latestPayload, {
              bloggerUserId: douyinNo,
            });
            await updateRecord(recordId, {
              status: RECORD_STATUS.DRAFT,
              payload: latestPayload,
            });
          }
        } catch (idError) {
          console.warn('[Sidebar] 抖音号补采失败(不影响主流程):', idError);
        } finally {
          if (profileNavigationAttempted && noteUrl) {
            try {
              await openUrlInTab(tab.id, noteUrl, {
                timeoutMs: detailNavTimeoutMs,
                active: true,
              });
            } catch (restoreError) {
              console.warn(
                '[Sidebar] 返回抖音作品页失败(不影响已采指标):',
                restoreError,
              );
            }
          }
        }
      }

      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_done',
          message: '博主指标采集完成',
          recordId,
        });
      }

      return {
        ok: true,
        recordId,
        patch: douyinMetricsResult.patch,
        error: null,
      };
    }

    if (!profileUrl) {
      throw new Error('未找到可访问的博主主页链接');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_open_profile',
        message: '正在跳转至博主主页...',
        recordId,
      });
    }
    await openUrlInTab(tab.id, profileUrl, {
      timeoutMs: detailNavTimeoutMs,
      shouldStop,
      active: true,
    });

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_wait_profile',
        message: '博主主页已打开，正在等待页面稳定...',
        recordId,
      });
    }
    await waitMsWithStop(
      profileAfterNavWaitMs,
      shouldStop,
      'BATCH_CAPTURE_CANCELED',
    );

    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_extract_profile',
        message: '正在抓取博主主页信息...',
        recordId,
      });
    }
    const profileResult = await captureInTab(tab.id, {
      mode: 'blogger_profile',
      captureParams: {},
    });
    if (!profileResult?.ok) {
      throw new Error(profileResult?.error?.message || '博主主页采集失败');
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_merging',
        message: '正在回填粉丝数、获赞收藏与账号属性...',
        recordId,
      });
    }
    const patch = resolveBloggerMetricsFromProfilePayload(
      profileResult.data,
      profileUrl,
    );
    latestPayload = applyBloggerMetricsPatch(latestPayload, patch);
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: latestPayload,
    });

    if (noteUrl && tab?.id) {
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_restoring_note',
          message: '正在返回原笔记页面...',
          recordId,
        });
      }
      try {
        await openUrlInTab(tab.id, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_done',
        message: '博主指标采集完成',
        recordId,
      });
    }

    return {
      ok: true,
      recordId,
      patch,
      error: null,
    };
  } catch (error) {
    if (platform !== 'douyin' && noteUrl && tab?.id) {
      if (onProgress) {
        onProgress({
          phase: 'blogger_metrics_restoring_note',
          message: '采集异常，正在返回原笔记页面...',
          recordId,
        });
      }
      try {
        await openUrlInTab(tab.id, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    latestPayload = applyBloggerMetricsPatch(
      latestPayload,
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.FAILED,
        error: error?.message || '博主指标采集失败',
        profileUrl,
      }),
    );
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: latestPayload,
    });

    if (onProgress) {
      onProgress({
        phase: 'blogger_metrics_failed',
        message: error?.message || '博主指标采集失败',
        recordId,
      });
    }

    return {
      ok: false,
      recordId,
      error: {
        code: 'BLOGGER_METRICS_CAPTURE_FAILED',
        message: error?.message || '博主指标采集失败',
      },
    };
  }
}

async function captureDouyinBloggerMetricsFromNoteDetail({
  tabId,
  expectedNoteId = '',
  preferWorksTabForBloggerMetrics = true,
} = {}) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return {
      ok: false,
      patch: null,
      error: '未找到可用标签页',
    };
  }

  let singleResult = null;
  try {
    singleResult = await captureInTab(normalizedTabId, {
      mode: 'single',
      captureParams: {
        expectedNoteId: String(expectedNoteId || ''),
        includeBloggerMetrics: true,
        preferWorksTabForBloggerMetrics: Boolean(
          preferWorksTabForBloggerMetrics,
        ),
      },
    });
  } catch (error) {
    const canceled =
      isBatchCaptureCanceledError(error) ||
      isDetailCaptureCanceledError(error);
    return {
      ok: false,
      canceled,
      patch: null,
      error: canceled
        ? 'DETAIL_CAPTURE_CANCELED'
        : error?.message || '抖音作品页补采失败',
    };
  }

  if (!singleResult?.ok) {
    if (isCaptureCanceledResult(singleResult)) {
      return {
        ok: false,
        canceled: true,
        patch: null,
        error: singleResult?.error?.message || '抖音作品页补采已取消',
      };
    }
    return {
      ok: false,
      patch: null,
      error: singleResult?.error?.message || '抖音作品页补采失败',
    };
  }

  const patch = resolveBloggerMetricsPatchFromCurrentPayload(
    singleResult?.data,
    { requireBothMetrics: true },
  );
  if (!patch) {
    return {
      ok: false,
      patch: null,
      error: '未能从TA的作品页解析博主粉丝数与获赞收藏',
    };
  }

  return {
    ok: true,
    patch,
    error: null,
  };
}

// 博主主页缓存 key:只按「host + 路径」(=博主身份),忽略 xsec_token 等 query。
// 否则同一博主不同帖带的 token 不同 → key 不同 → 缓存不命中 → 重复进同一个主页(多余导航 + 风控)。
function bloggerProfileCacheKey(profileUrl) {
  try {
    const u = new URL(profileUrl);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return String(profileUrl || '');
  }
}

async function captureBloggerMetricsForDetailPayload(
  detailPayload,
  {
    tabId,
    noteUrl,
    detailNavTimeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    profileAfterNavWaitMs = PROFILE_AFTER_NAV_WAIT_MS,
    shouldStop = null,
    cache = null,
    allowProfileNavigation = true,
    allowDouyinIdLookup = false,
    expectedNoteId = '',
    preferWorksTabForBloggerMetrics = false,
    navigate = openUrlInTab,
  } = {},
) {
  const normalizedPayload = ensureBloggerMetricsFields(detailPayload);
  const platform = detectPlatformFromUrl(
    noteUrl ||
      normalizedPayload.url ||
      normalizedPayload.noteUrl ||
      normalizedPayload.authorUrl ||
      normalizedPayload.bloggerProfileUrl ||
      '',
  );
  const directPatch = resolveBloggerMetricsPatchFromCurrentPayload(
    normalizedPayload,
    { requireBothMetrics: platform === 'douyin' },
  );
  if (directPatch) {
    // 抖音:作品页指标已齐(directPatch),但 directPatch 多半不含真抖音号
    // (号只在博主主页正文「抖音号:xxx」,作品页 API 的 unique_id 常缺)。
    // 在 return 之前、与指标早返回解耦地补一次号(fail-soft,不影响已采到的指标)。
    if (platform === 'douyin' && allowDouyinIdLookup) {
      await maybeAttachDouyinAccountNo(directPatch, normalizedPayload, {
        tabId,
        noteUrl,
        detailNavTimeoutMs,
        profileAfterNavWaitMs,
        shouldStop,
        cache,
        navigate,
      });
    }
    return {
      ok: true,
      canceled: false,
      profileUrl:
        directPatch.bloggerProfileUrl ||
        normalizedPayload.bloggerProfileUrl ||
        '',
      patch: directPatch,
      error: '',
    };
  }

  if (platform === 'douyin') {
    const douyinMetricsResult =
      await captureDouyinBloggerMetricsFromNoteDetail({
        tabId,
        expectedNoteId,
        preferWorksTabForBloggerMetrics,
      });
    if (douyinMetricsResult?.ok && douyinMetricsResult.patch) {
      if (allowDouyinIdLookup) {
        await maybeAttachDouyinAccountNo(
          douyinMetricsResult.patch,
          normalizedPayload,
          {
            tabId,
            noteUrl,
            detailNavTimeoutMs,
            profileAfterNavWaitMs,
            shouldStop,
            cache,
            navigate,
          },
        );
      }
      return {
        ok: true,
        canceled: false,
        profileUrl:
          douyinMetricsResult.patch.bloggerProfileUrl ||
          normalizedPayload.bloggerProfileUrl ||
          '',
        patch: douyinMetricsResult.patch,
        error: '',
      };
    }
    return {
      ok: false,
      canceled: Boolean(douyinMetricsResult?.canceled),
      profileUrl: normalizedPayload.bloggerProfileUrl || '',
      error:
        douyinMetricsResult?.error ||
        '未能从作品详情页直接解析博主指标',
    };
  }

  if (!allowProfileNavigation) {
    return {
      ok: false,
      canceled: false,
      profileUrl: '',
      error: '未能从作品详情页直接解析博主指标',
    };
  }

  const profileUrl = resolveBloggerProfileUrlFromPayload(normalizedPayload);
  if (!profileUrl) {
    return {
      ok: false,
      canceled: false,
      profileUrl: '',
      error: '未找到可访问的博主主页链接',
    };
  }

  const cacheKey = bloggerProfileCacheKey(profileUrl);
  if (cache instanceof Map && cache.has(cacheKey)) {
    return cache.get(cacheKey); // 同博主一轮只进一次主页
  }

  if (typeof shouldStop === 'function' && shouldStop()) {
    return {
      ok: false,
      canceled: true,
      profileUrl,
      error: 'DETAIL_CAPTURE_CANCELED',
    };
  }

  try {
    // 打散「笔记页 → 主页」的连续导航(burst 也是风控信号),进主页前小随机抖动
    await waitMs(
      PROFILE_NAV_JITTER_MIN_MS +
        Math.floor(Math.random() * (PROFILE_NAV_JITTER_MAX_MS - PROFILE_NAV_JITTER_MIN_MS)),
    );
    await navigate(tabId, profileUrl, {
      timeoutMs: detailNavTimeoutMs,
      shouldStop,
      active: true,
    });
    await waitMs(profileAfterNavWaitMs);

    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        profileUrl,
        error: 'DETAIL_CAPTURE_CANCELED',
      };
    }

    const profileResult = await captureInTab(tabId, {
      mode: 'blogger_profile',
      captureParams: {},
    });
    if (!profileResult?.ok) {
      throw new Error(profileResult?.error?.message || '博主主页采集失败');
    }
    if (
      String(profileResult?.data?.bloggerMetricsCaptureStatus || '')
        .trim()
        .toLowerCase() === BLOGGER_METRICS_CAPTURE_STATUS.FAILED
    ) {
      throw new Error(
        profileResult?.data?.bloggerMetricsCaptureError ||
          '博主主页未能确认粉丝与互动指标',
      );
    }

    if (noteUrl) {
      try {
        await navigate(tabId, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          shouldStop,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }

    const result = {
      ok: true,
      canceled: false,
      profileUrl,
      patch: resolveBloggerMetricsFromProfilePayload(
        profileResult.data,
        profileUrl,
      ),
      error: '',
    };
    if (cache instanceof Map) {
      cache.set(cacheKey, result);
    }
    return result;
  } catch (error) {
    const canceled = isBatchCaptureCanceledError(error);
    const failedResult = {
      ok: false,
      canceled,
      profileUrl,
      error: canceled
        ? 'BATCH_CAPTURE_CANCELED'
        : error?.message || '博主指标采集失败',
    };
    if (cache instanceof Map && !canceled) {
      cache.set(cacheKey, failedResult);
    }
    if (noteUrl) {
      try {
        await navigate(tabId, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          shouldStop,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }
    return failedResult;
  }
}

// 抖音专用:仅为补「抖音号(douyinId)」进一次博主主页,复用 cache + jitter + 回原页 + shouldStop,
// 失败 fail-soft 吞掉(不改指标、不丢记录、不停批)。命中时把真号写进 patch.bloggerUserId 并返回 true。
// 真号只在主页正文(extractDouyinId「抖音号:xxx」);sec_uid 会被 pickHumanAccountNo 过滤,绝不入库。
async function maybeAttachDouyinAccountNo(
  patch,
  normalizedPayload,
  {
    tabId,
    noteUrl,
    detailNavTimeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    profileAfterNavWaitMs = PROFILE_AFTER_NAV_WAIT_MS,
    shouldStop = null,
    cache = null,
    navigate = openUrlInTab,
  } = {},
) {
  // 已有真号(patch 上、或 detailPayload 的 douyinId/authorUsername)→ 跳过导航,省一次进主页。
  // 展开顺序要点:normalizedPayload 先铺开,再用 patch 的 bloggerUserId 覆盖——
  // ensureBloggerMetricsFields 总会带个空 bloggerUserId 键,若放后面会把 patch 已有的真号洗掉。
  const existingNo = pickHumanAccountNo({
    ...normalizedPayload,
    bloggerUserId: patch?.bloggerUserId || normalizedPayload.bloggerUserId,
  });
  if (existingNo) {
    if (patch) patch.bloggerUserId = existingNo;
    return true;
  }

  const profileUrl = resolveBloggerProfileUrlFromPayload(normalizedPayload);
  if (!profileUrl || !tabId) return false;
  if (typeof shouldStop === 'function' && shouldStop()) return false;

  // 与小红书 metrics 缓存分开命名空间('douyinId:' 前缀),避免误命中混用;同博主一轮只进一次主页。
  const idCacheKey = 'douyinId:' + bloggerProfileCacheKey(profileUrl);
  if (cache instanceof Map && cache.has(idCacheKey)) {
    const cachedNo = cache.get(idCacheKey);
    if (cachedNo && patch) patch.bloggerUserId = cachedNo;
    return Boolean(cachedNo);
  }

  try {
    // 进主页前抖动,打散「笔记页 → 主页」burst(同小红书路)
    await waitMs(
      PROFILE_NAV_JITTER_MIN_MS +
        Math.floor(
          Math.random() *
            (PROFILE_NAV_JITTER_MAX_MS - PROFILE_NAV_JITTER_MIN_MS),
        ),
    );
    await navigate(tabId, profileUrl, {
      timeoutMs: detailNavTimeoutMs,
      shouldStop,
      active: true,
    });
    await waitMs(profileAfterNavWaitMs);

    if (typeof shouldStop === 'function' && shouldStop()) {
      return false;
    }

    const idResult = await captureInTab(tabId, {
      mode: 'blogger_profile',
      captureParams: {},
    });
    // 真抖音号在 data.douyinId;data.bloggerId 是 sec_uid(MS4w...),被 pickHumanAccountNo 过滤掉
    const douyinNo = idResult?.ok ? pickHumanAccountNo(idResult.data) : '';
    if (cache instanceof Map) {
      cache.set(idCacheKey, douyinNo || ''); // 失败也缓存空串,同博主一轮不再撞墙
    }
    if (douyinNo && patch) {
      patch.bloggerUserId = douyinNo;
    }
    return Boolean(douyinNo);
  } catch (idError) {
    console.warn('[CaptureSync] 抖音号补采失败(不影响主流程):', idError);
    return false;
  } finally {
    // 无论成败都回原笔记页 —— 后续还要在【当前页】采评论,不能停在博主主页
    if (noteUrl) {
      try {
        await navigate(tabId, noteUrl, {
          timeoutMs: detailNavTimeoutMs,
          shouldStop,
          active: true,
        });
      } catch (restoreError) {
        console.warn('[CaptureSync] restore note page failed:', restoreError);
      }
    }
  }
}

function normalizeCommentsMaxDetectedItems(maxDetectedItems, fallback) {
  const num = Number(maxDetectedItems);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
}

function commentCapturePartialMessage({
  stopReason = '',
  stoppedByUser = false,
  stoppedByStall = false,
  stoppedByNetwork = false,
  collectedCount = null,
} = {}) {
  const normalizedReason = String(stopReason || '').trim().toLowerCase();
  const count = Number(collectedCount);
  const saved = Number.isFinite(count) && count >= 0
    ? `${Math.floor(count)} 条`
    : '当前结果';
  if (stoppedByNetwork || normalizedReason === 'network_timeout') {
    return `网络中断超过 2 分钟，已保留 ${saved}；联网后可继续采集`;
  }
  if (stoppedByStall) {
    return `评论页面卡顿，已保留 ${saved}；可继续采集`;
  }
  if (normalizedReason === 'max_duration') {
    return `达到评论采集安全时限，已保留 ${saved}；可继续采集`;
  }
  if (normalizedReason === 'max_scroll') {
    return `达到配置的评论滚动上限，已保留 ${saved}；可继续采集`;
  }
  if (stoppedByUser || normalizedReason === 'canceled') {
    return Number.isFinite(count) && count >= 0
      ? `评论已手动停止并合并（${Math.floor(count)}条）`
      : '评论已手动停止并保留当前结果';
  }
  return `评论采集尚未完成，已保留 ${saved}；可继续采集`;
}

function normalizePositiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return Math.max(1, Math.floor(Number(fallback) || 1));
  }
  return Math.max(1, Math.floor(num));
}

function sanitizeCommentLeadItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const normalized = normalizeCommentItemForLead(item);
      if (!normalized.content) return null;
      return {
        ...normalized,
        matchedKeywords: splitCommentLeadRules(item?.matchedKeywords),
      };
    })
    .filter(Boolean);
}

function normalizeCommentLeadSyncStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'not_started' ||
    normalized === 'done' ||
    normalized === 'failed' ||
    normalized === 'skipped'
  ) {
    return normalized;
  }
  return 'not_started';
}

function applyCommentStatusToPayload(payload, patch) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const baseLeadItems = sanitizeCommentLeadItems(base.commentLeadsItems);
  const patchLeadItems = sanitizeCommentLeadItems(patch.commentLeadsItems);
  return {
    ...base,
    commentsTotalCaptured: patch.commentsTotalCaptured ?? base.commentsTotalCaptured ?? 0,
    commentsCleanedItems: Array.isArray(patch.commentsCleanedItems)
      ? patch.commentsCleanedItems
      : Array.isArray(base.commentsCleanedItems)
        ? base.commentsCleanedItems
        : [],
    commentsMergedText: patch.commentsMergedText ?? base.commentsMergedText ?? '',
    commentsCaptureStatus:
      patch.commentsCaptureStatus ?? base.commentsCaptureStatus ?? COMMENT_CAPTURE_STATUS.NOT_STARTED,
    commentsCaptureStoppedByUser:
      patch.commentsCaptureStoppedByUser ?? base.commentsCaptureStoppedByUser ?? false,
    commentsCaptureStartedAt: patch.commentsCaptureStartedAt ?? base.commentsCaptureStartedAt ?? 0,
    commentsCaptureFinishedAt:
      patch.commentsCaptureFinishedAt ?? base.commentsCaptureFinishedAt ?? 0,
    commentsCaptureError: patch.commentsCaptureError ?? base.commentsCaptureError ?? '',
    commentLeadsEnabled: Boolean(
      patch.commentLeadsEnabled ?? base.commentLeadsEnabled ?? false,
    ),
    commentLeadsKeywords:
      patch.commentLeadsKeywords !== undefined
        ? splitCommentLeadRules(patch.commentLeadsKeywords)
        : splitCommentLeadRules(base.commentLeadsKeywords),
    commentLeadsIps:
      patch.commentLeadsIps !== undefined
        ? splitCommentLeadRules(patch.commentLeadsIps)
        : splitCommentLeadRules(base.commentLeadsIps),
    commentLeadsItems: patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
      ? patchLeadItems
      : baseLeadItems,
    commentLeadsTotal:
      patch.commentLeadsTotal ??
      (patchLeadItems.length > 0 || patch.commentLeadsItems !== undefined
        ? patchLeadItems.length
        : base.commentLeadsTotal ?? baseLeadItems.length),
    commentLeadsLastComputedAt:
      patch.commentLeadsLastComputedAt ?? base.commentLeadsLastComputedAt ?? 0,
    commentLeadsSyncStatus: normalizeCommentLeadSyncStatus(
      patch.commentLeadsSyncStatus ?? base.commentLeadsSyncStatus ?? 'not_started',
    ),
    commentLeadsSyncError: String(
      patch.commentLeadsSyncError ?? base.commentLeadsSyncError ?? '',
    ),
  };
}

function createCommentStatusPatch({
  status,
  startedAt,
  finishedAt,
  stoppedByUser,
  error,
  cleanedItems = null,
  mergedText = null,
  commentLeadsEnabled = undefined,
  commentLeadsKeywords = undefined,
  commentLeadsIps = undefined,
  commentLeadsItems = undefined,
  commentLeadsTotal = undefined,
  commentLeadsLastComputedAt = undefined,
  commentLeadsSyncStatus = undefined,
  commentLeadsSyncError = undefined,
}) {
  const patch = {
    commentsCaptureStatus: status,
    commentsCaptureStartedAt: startedAt,
    commentsCaptureFinishedAt: finishedAt,
    commentsCaptureStoppedByUser: stoppedByUser,
    commentsCaptureError: error,
  };

  if (Array.isArray(cleanedItems)) {
    patch.commentsCleanedItems = cleanedItems;
    patch.commentsTotalCaptured = cleanedItems.length;
  }

  if (typeof mergedText === 'string') {
    patch.commentsMergedText = mergedText;
  }

  if (commentLeadsEnabled !== undefined) {
    patch.commentLeadsEnabled = Boolean(commentLeadsEnabled);
  }
  if (commentLeadsKeywords !== undefined) {
    patch.commentLeadsKeywords = splitCommentLeadRules(commentLeadsKeywords);
  }
  if (commentLeadsIps !== undefined) {
    patch.commentLeadsIps = splitCommentLeadRules(commentLeadsIps);
  }
  if (commentLeadsItems !== undefined) {
    patch.commentLeadsItems = sanitizeCommentLeadItems(commentLeadsItems);
  }
  if (commentLeadsTotal !== undefined) {
    patch.commentLeadsTotal = normalizeNonNegativeNumber(commentLeadsTotal);
  }
  if (commentLeadsLastComputedAt !== undefined) {
    patch.commentLeadsLastComputedAt = normalizeNonNegativeNumber(commentLeadsLastComputedAt);
  }
  if (commentLeadsSyncStatus !== undefined) {
    patch.commentLeadsSyncStatus = normalizeCommentLeadSyncStatus(commentLeadsSyncStatus);
  }
  if (commentLeadsSyncError !== undefined) {
    patch.commentLeadsSyncError = String(commentLeadsSyncError || '');
  }

  return patch;
}

function cleanCommentsItems(items) {
  const normalized = [];

  items.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const content = String(item.content || item.commentContent || '').replace(/\s+/g, ' ').trim();
    if (!content) return;
    const normalizedContent =
      content.length > COMMENT_CONTENT_MAX_LENGTH
        ? `${content.slice(0, COMMENT_CONTENT_MAX_LENGTH)}...`
        : content;
    const likesNum = Number(item.likes ?? item.likeCount);
    const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
    const userId = resolveCommentUserId(item);
    const userName = resolveCommentUserName(item);
    const userUrl = resolveCommentUserUrl(item);
    const ipLocation = resolveCommentIpLocation(item);
    const publishTime = String(item.publishTime || item.publishedAt || item.time || item.date || '').trim();
    const preferredId = String(item.commentId || item.id || '').trim();
    normalized.push({
      ...(preferredId ? { commentId: preferredId } : {}),
      content: normalizedContent,
      likes,
      ...(userName ? { userName } : {}),
      ...(userId ? { userId } : {}),
      ...(userUrl ? { userUrl } : {}),
      ...(ipLocation ? { ipLocation } : {}),
      ...(publishTime ? { publishTime } : {}),
    });
  });

  return dedupeNormalizedCommentItems(normalized);
}

function buildCommentsMergedText(items) {
  return items
    .map((item, index) => {
      const name = String(item?.userName || '匿名用户').trim() || '匿名用户';
      const ip = String(item?.ipLocation || '未知IP').trim() || '未知IP';
      const content = String(item?.content || '').trim();
      const likes = Number(item?.likes || 0);
      return `${index + 1}、${name}（${ip}）：${content}（${Number.isFinite(likes) ? Math.max(0, Math.floor(likes)) : 0} 个赞）`;
    })
    .join('\n');
}

function splitCommentLeadRules(rawValue) {
  if (Array.isArray(rawValue)) {
    return Array.from(
      new Set(
        rawValue
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    );
  }

  return Array.from(
    new Set(
      String(rawValue || '')
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function buildCommentLeadsConfigFromSettings(settings = {}) {
  return normalizeCommentLeadsConfig({
    enabled:
      settings.enableCommentLeadsFilter ??
      settings.commentLeadsEnabled ??
      false,
    keywords:
      settings.commentLeadsKeywords ??
      settings.keywords ??
      '',
    ips:
      settings.commentLeadsIps ??
      settings.ips ??
      '',
  });
}

function normalizeCommentLeadsConfig(input = {}) {
  const safe = input && typeof input === 'object' ? input : {};
  const enabled = Boolean(safe.enabled);
  const keywords = splitCommentLeadRules(safe.keywords);
  const ips = splitCommentLeadRules(safe.ips);
  return {
    enabled,
    keywords,
    ips,
    hasKeywordRules: keywords.length > 0,
    hasIpRules: ips.length > 0,
    hasRules: keywords.length > 0 || ips.length > 0,
  };
}

function normalizeCommentItemForLead(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const likesNum = Number(safeItem.likes ?? safeItem.likeCount);
  const likes = Number.isFinite(likesNum) && likesNum >= 0 ? Math.floor(likesNum) : 0;
  return {
    content: String(safeItem.content || safeItem.commentContent || '').replace(/\s+/g, ' ').trim(),
    userName: resolveCommentUserName(safeItem),
    ipLocation: resolveCommentIpLocation(safeItem),
    likes,
    userUrl: resolveCommentUserUrl(safeItem),
    userId: resolveCommentUserId(safeItem),
  };
}

function pickFirstNonEmptyString(candidates = []) {
  if (!Array.isArray(candidates)) return '';
  for (const candidate of candidates) {
    const text = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text;
  }
  return '';
}

function extractUserIdFromProfileUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  const match = text.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/i);
  return match?.[1] || '';
}

function resolveCommentUserName(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userName,
    safeItem.nickname,
    safeItem.user_name,
    safeItem.authorName,
    safeItem.author,
    safeItem.name,
    user.userName,
    user.nickname,
    user.name,
    safeItem['user-name'],
    safeItem['user_name'],
  ]);
}

function resolveCommentIpLocation(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.ipLocation,
    safeItem.ip,
    safeItem.location,
    safeItem.region,
    safeItem.ip_location,
    safeItem.userIpLocation,
    safeItem['ip属地'],
    user.ipLocation,
    user.location,
    user.region,
  ]);
}

function resolveCommentUserUrl(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userUrl,
    safeItem.userURL,
    safeItem.profileUrl,
    safeItem.homeUrl,
    user.userUrl,
    user.profileUrl,
  ]);
}

function resolveCommentUserId(item) {
  const safeItem = item && typeof item === 'object' ? item : {};
  const user = safeItem.user && typeof safeItem.user === 'object' ? safeItem.user : {};
  return pickFirstNonEmptyString([
    safeItem.userId,
    safeItem.uid,
    safeItem.user_id,
    user.userId,
    user.uid,
    user.id,
    extractUserIdFromProfileUrl(resolveCommentUserUrl(safeItem)),
  ]);
}

function getLeadSourceFromSyncPayload(syncType, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};

  if (syncType === SYNC_TYPE.SINGLE_NOTE) {
    const fallbackComments =
      Array.isArray(safePayload.commentsCleanedItems)
        ? safePayload.commentsCleanedItems
        : Array.isArray(safePayload.commentItems)
          ? safePayload.commentItems
          : Array.isArray(safePayload.commentsItems)
            ? safePayload.commentsItems
            : Array.isArray(safePayload.comments)
              ? safePayload.comments
              : Array.isArray(safePayload.items)
                ? safePayload.items
                : [];
    return {
      noteUrl: String(safePayload.url || safePayload.noteUrl || '').trim(),
      noteTitle: String(safePayload.title || safePayload.noteTitle || '').trim(),
      comments: fallbackComments,
    };
  }

  if (syncType === SYNC_TYPE.COMMENTS) {
    return {
      noteUrl: String(safePayload.noteUrl || '').trim(),
      noteTitle: String(safePayload.noteTitle || '').trim(),
      comments: Array.isArray(safePayload.items) ? safePayload.items : [],
    };
  }

  if (syncType === SYNC_TYPE.BLOGGER_NOTES || syncType === SYNC_TYPE.KEYWORD_NOTES) {
    const firstItem =
      Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
        ? safePayload.items[0]
        : {};
    const fallbackComments =
      Array.isArray(firstItem.commentsCleanedItems)
        ? firstItem.commentsCleanedItems
        : Array.isArray(firstItem.commentItems)
          ? firstItem.commentItems
          : Array.isArray(firstItem.commentsItems)
            ? firstItem.commentsItems
            : Array.isArray(firstItem.comments)
              ? firstItem.comments
              : Array.isArray(safePayload.commentsCleanedItems)
                ? safePayload.commentsCleanedItems
                : Array.isArray(safePayload.comments)
                  ? safePayload.comments
                  : [];
    return {
      noteUrl: String(firstItem.url || firstItem.noteUrl || safePayload.detailCaptureNoteUrl || '').trim(),
      noteTitle: String(firstItem.title || firstItem.noteTitle || '').trim(),
      comments: fallbackComments,
    };
  }

  return {
    noteUrl: '',
    noteTitle: '',
    comments: [],
  };
}

function evaluateCommentLeadItem(item, config) {
  const normalizedItem = normalizeCommentItemForLead(item);
  if (!normalizedItem.content) {
    return null;
  }

  const contentLower = normalizedItem.content.toLowerCase();
  const matchedKeywords = config.keywords.filter((keyword) =>
    contentLower.includes(keyword.toLowerCase()),
  );
  const keywordMatched = !config.hasKeywordRules || matchedKeywords.length > 0;
  const ipMatched = !config.hasIpRules || config.ips.includes(normalizedItem.ipLocation);
  if (!keywordMatched || !ipMatched) {
    return null;
  }

  return {
    ...normalizedItem,
    matchedKeywords,
  };
}

function getStoredCommentLeadsState(syncType, payload) {
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const source = getLeadSourceFromSyncPayload(syncType, safePayload);
  const firstItem =
    Array.isArray(safePayload.items) && safePayload.items[0] && typeof safePayload.items[0] === 'object'
      ? safePayload.items[0]
      : {};

  const rawItems =
    Array.isArray(firstItem.commentLeadsItems)
      ? firstItem.commentLeadsItems
      : Array.isArray(safePayload.commentLeadsItems)
        ? safePayload.commentLeadsItems
        : [];
  const items = sanitizeCommentLeadItems(rawItems);
  const totalRaw =
    firstItem.commentLeadsTotal ??
    safePayload.commentLeadsTotal ??
    items.length;
  const matchedCount = normalizeNonNegativeNumber(totalRaw);

  if (!source.noteUrl || items.length === 0 || matchedCount <= 0) {
    return {
      matchedCount: 0,
      payload: null,
    };
  }

  return {
    matchedCount: Math.max(matchedCount, items.length),
    payload: {
      noteUrl: source.noteUrl,
      noteTitle: source.noteTitle,
      captureTimestamp:
        Number(safePayload.commentLeadsLastComputedAt || firstItem.commentLeadsLastComputedAt || 0) ||
        Date.now(),
      filterConfigSnapshot: {
        keywords: splitCommentLeadRules(
          safePayload.commentLeadsKeywords ?? firstItem.commentLeadsKeywords,
        ),
        ips: splitCommentLeadRules(
          safePayload.commentLeadsIps ?? firstItem.commentLeadsIps,
        ),
      },
      items,
    },
  };
}

function hasStoredCommentLeadsPayload(syncType, payload) {
  return Boolean(getStoredCommentLeadsState(syncType, payload)?.payload);
}

export function buildCommentLeadsPayloadForRecord(record, configInput = {}, options = {}) {
  const syncInput = resolveSyncInputForRecord(record);
  const config = normalizeCommentLeadsConfig(configInput);
  const source = getLeadSourceFromSyncPayload(syncInput.syncType, syncInput.payload);
  const preferStored = Boolean(options?.preferStored);
  const storedLeadState = getStoredCommentLeadsState(
    syncInput.syncType,
    syncInput.payload,
  );
  const normalizedComments = source.comments
    .map((item) => normalizeCommentItemForLead(item))
    .filter((item) => item.content);
  const result = {
    enabled: config.enabled,
    hasRules: config.hasRules,
    totalComments: normalizedComments.length,
    matchedCount: 0,
    skipReason: '',
    payload: null,
    source: '',
  };

  if (preferStored && storedLeadState.payload) {
    result.matchedCount = storedLeadState.matchedCount;
    result.payload = storedLeadState.payload;
    result.source = 'stored';
    return result;
  }

  if (!config.enabled) {
    result.skipReason = 'disabled';
    return result;
  }

  if (!config.hasRules) {
    result.skipReason = 'no_rules';
    return result;
  }

  if (!source.noteUrl) {
    result.skipReason = 'missing_note_url';
    return result;
  }

  if (normalizedComments.length === 0) {
    result.skipReason = 'no_comments';
    return result;
  }

  const matchedItems = source.comments
    .map((item) => evaluateCommentLeadItem(item, config))
    .filter(Boolean);
  result.matchedCount = matchedItems.length;

  if (matchedItems.length === 0) {
    result.skipReason = 'zero_matched';
    return result;
  }

  result.payload = {
    noteUrl: source.noteUrl,
    noteTitle: source.noteTitle,
    captureTimestamp: Date.now(),
    filterConfigSnapshot: {
      keywords: config.keywords,
      ips: config.ips,
    },
    items: matchedItems,
  };
  result.source = 'computed';

  return result;
}

function applyCommentLeadsSyncState(payload, {
  config,
  leadResult,
  syncStatus = 'not_started',
  syncError = '',
} = {}) {
  const safeConfig = normalizeCommentLeadsConfig(config);
  const safeLeadResult =
    leadResult && typeof leadResult === 'object'
      ? leadResult
      : { matchedCount: 0, payload: null };
  return applyCommentStatusToPayload(
    payload,
    createCommentStatusPatch({
      status: String(payload?.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED),
      startedAt: Number(payload?.commentsCaptureStartedAt || 0),
      finishedAt: Number(payload?.commentsCaptureFinishedAt || 0),
      stoppedByUser: Boolean(payload?.commentsCaptureStoppedByUser),
      error: String(payload?.commentsCaptureError || ''),
      cleanedItems: Array.isArray(payload?.commentsCleanedItems)
        ? payload.commentsCleanedItems
        : [],
      mergedText: String(payload?.commentsMergedText || ''),
      commentLeadsEnabled: safeConfig.enabled,
      commentLeadsKeywords: safeConfig.keywords,
      commentLeadsIps: safeConfig.ips,
      commentLeadsItems: safeLeadResult?.payload?.items || [],
      commentLeadsTotal: Number(safeLeadResult?.matchedCount || 0),
      commentLeadsLastComputedAt: Date.now(),
      commentLeadsSyncStatus: syncStatus,
      commentLeadsSyncError: syncError,
    }),
  );
}

function normalizeBloggerAccountType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'famous') return 'famous';
  if (normalized === 'company') return 'company';
  return '';
}

function normalizeNonNegativeNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return Math.floor(num);
}

function normalizeOptionalCount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = parseInteractionCount(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function isExplicitCountValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0;
  }
  return /[0-9]/u.test(String(value ?? ''));
}

function resolveProvenBloggerMetricCount(
  payload,
  {
    valueKeys = [],
    knownKeys = [],
  } = {},
) {
  const safePayload =
    payload && typeof payload === 'object' ? payload : {};
  const explicitlyKnown = knownKeys.some(
    (key) => safePayload[key] === true,
  );

  for (const key of valueKeys) {
    if (!Object.prototype.hasOwnProperty.call(safePayload, key)) continue;
    const rawCount = safePayload[key];
    if (!isExplicitCountValue(rawCount)) continue;
    const count = normalizeOptionalCount(rawCount);
    if (count === null) continue;
    // Positive values cannot be introduced by the zero-default normalizer.
    // Zero is evidence only when the extractor explicitly marks the metric
    // known; a generic completed/defaulted payload is not sufficient proof.
    if (count > 0 || explicitlyKnown) return count;
  }
  return null;
}

function resolveProvenBloggerFollowersCount(payload) {
  return resolveProvenBloggerMetricCount(payload, {
    valueKeys: ['bloggerFollowersCount', 'followersCount'],
    knownKeys: ['bloggerFollowersCountKnown', 'followersCountKnown'],
  });
}

function resolveProvenBloggerLikedAndCollectedCount(payload) {
  return resolveProvenBloggerMetricCount(payload, {
    valueKeys: [
      'bloggerLikedAndCollectedCount',
      'likedAndCollectedCount',
    ],
    knownKeys: [
      'bloggerLikedAndCollectedCountKnown',
      'likedAndCollectedCountKnown',
    ],
  });
}

function pickFirstCountFromSources(sources = [], keys = []) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const count = normalizeOptionalCount(source[key]);
      if (count !== null) return count;
    }
  }
  return null;
}

function resolveRecordListCommentsCount(record = {}) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  return pickFirstCountFromSources([firstItem, payload], [
    'comments',
    'commentCount',
    'comment_count',
    'commentsCount',
    'comments_count',
  ]);
}

export function resolveKnownCommentsCountForDetailCapture(
  record = {},
  detailPayload = {},
) {
  const countKeys = [
    'comments',
    'commentCount',
    'comment_count',
    'commentsCount',
    'comments_count',
  ];
  const knownKeys = [
    'commentsCountKnown',
    'commentCountKnown',
    'comment_count_known',
    'comments_count_known',
  ];
  const pickProvenCount = (sources = []) => {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const isKnown = knownKeys.some((key) => source[key] === true);
      if (!isKnown) continue;
      for (const key of countKeys) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const rawCount = source[key];
        if (
          typeof rawCount !== 'number' &&
          !/[0-9]/.test(String(rawCount ?? ''))
        ) {
          continue;
        }
        const count = normalizeOptionalCount(rawCount);
        if (count !== null) return count;
      }
    }
    return null;
  };

  const detailCount = pickProvenCount([detailPayload]);
  if (detailCount !== null) return detailCount;

  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  return pickProvenCount([firstItem, payload]);
}

function isValidBloggerMetricsStatus(status) {
  return (
    status === BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED ||
    status === BLOGGER_METRICS_CAPTURE_STATUS.DONE ||
    status === BLOGGER_METRICS_CAPTURE_STATUS.FAILED
  );
}

function isFiniteNonNegativeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0;
}

function ensureBloggerMetricsFields(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const rawStatus = String(base.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  const status = isValidBloggerMetricsStatus(rawStatus)
    ? rawStatus
    : BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;

  return {
    ...base,
    bloggerFollowersCount: normalizeNonNegativeNumber(
      base.bloggerFollowersCount ?? base.followersCount,
    ),
    bloggerLikedAndCollectedCount: normalizeNonNegativeNumber(
      base.bloggerLikedAndCollectedCount ?? base.likedAndCollectedCount,
    ),
    bloggerFollowersCountKnown:
      base.bloggerFollowersCountKnown === true ||
      base.followersCountKnown === true,
    bloggerLikedAndCollectedCountKnown:
      base.bloggerLikedAndCollectedCountKnown === true ||
      base.likedAndCollectedCountKnown === true,
    bloggerProfileUrl: String(base.bloggerProfileUrl || base.authorUrl || ''),
    bloggerMetricsCaptureStatus: status,
    bloggerMetricsCaptureError: String(base.bloggerMetricsCaptureError || ''),
    bloggerAccountType: normalizeBloggerAccountType(base.bloggerAccountType),
    bloggerUserId: String(base.bloggerUserId || ''),
  };
}

function applyBloggerMetricsPatch(payload, patch) {
  const base = ensureBloggerMetricsFields(payload);
  const bloggerName = patch.bloggerName === undefined
    ? ''
    : String(patch.bloggerName || '').trim();
  return {
    ...base,
    ...(bloggerName
      ? {
          bloggerName,
          author: bloggerName,
          authorName: bloggerName,
          authorNameBoundToProfile: true,
        }
      : {}),
    bloggerFollowersCount:
      patch.bloggerFollowersCount ?? base.bloggerFollowersCount,
    bloggerLikedAndCollectedCount:
      patch.bloggerLikedAndCollectedCount ?? base.bloggerLikedAndCollectedCount,
    bloggerFollowersCountKnown:
      patch.bloggerFollowersCountKnown ?? base.bloggerFollowersCountKnown,
    bloggerLikedAndCollectedCountKnown:
      patch.bloggerLikedAndCollectedCountKnown ??
      base.bloggerLikedAndCollectedCountKnown,
    bloggerProfileUrl: patch.bloggerProfileUrl ?? base.bloggerProfileUrl,
    bloggerMetricsCaptureStatus:
      patch.bloggerMetricsCaptureStatus ?? base.bloggerMetricsCaptureStatus,
    bloggerMetricsCaptureError:
      patch.bloggerMetricsCaptureError ?? base.bloggerMetricsCaptureError,
    bloggerAccountType: patch.bloggerAccountType ?? base.bloggerAccountType,
    bloggerUserId: patch.bloggerUserId ?? base.bloggerUserId,
  };
}

function createBloggerMetricsPatch({
  status,
  followersCount,
  likedAndCollectedCount,
  profileUrl,
  error,
  accountType,
  bloggerId,
  bloggerName,
  followersCountKnown,
  likedAndCollectedCountKnown,
}) {
  const patch = {
    bloggerMetricsCaptureStatus: status,
    bloggerMetricsCaptureError: String(error || ''),
  };

  if (followersCount !== undefined) {
    patch.bloggerFollowersCount = normalizeNonNegativeNumber(followersCount);
  }
  if (likedAndCollectedCount !== undefined) {
    patch.bloggerLikedAndCollectedCount = normalizeNonNegativeNumber(
      likedAndCollectedCount,
    );
  }
  if (followersCountKnown !== undefined) {
    patch.bloggerFollowersCountKnown = followersCountKnown === true;
  }
  if (likedAndCollectedCountKnown !== undefined) {
    patch.bloggerLikedAndCollectedCountKnown =
      likedAndCollectedCountKnown === true;
  }
  if (profileUrl !== undefined) {
    patch.bloggerProfileUrl = String(profileUrl || '');
  }
  if (accountType !== undefined) {
    patch.bloggerAccountType = normalizeBloggerAccountType(accountType);
  }
  if (bloggerId !== undefined) {
    patch.bloggerUserId = String(bloggerId || '');
  }
  if (bloggerName !== undefined) {
    patch.bloggerName = String(bloggerName || '').trim();
  }

  return patch;
}

// 平台「内部 ID」≠「人看的账号号」。绝不能把内部 ID 当成小红书号/抖音号入库:
//  - 小红书 user_id:24 位十六进制(如 5700cb384775a72931d38e56,来自 /user/profile/xxx)
//  - 抖音 sec_uid:MS4w 开头长串(如 MS4wLjABAAAA...,来自 /user/xxx)
// 真正的号是人能搜的字母数字串(小红书号 chengyao1218 / 抖音号 zhangjimin1950)。
function isInternalAccountNo(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (/^[0-9a-f]{24}$/i.test(v)) return true; // 小红书内部 user_id
  if (/^MS4w/i.test(v)) return true; // 抖音 sec_uid
  return false;
}

// 从博主 payload 里挑出「人看的账号号」,按可信度排序,且过滤掉内部 ID。
function pickHumanAccountNo(payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const candidates = [
    p.bloggerUserId,
    p.redId,
    p.douyinId, // 抖音号(extractDouyinId),非 sec_uid
    p.authorUsername, // 抖音作品页 API unique_id
    p.bloggerId, // 小红书:此处常是号;但抖音是 sec_uid → 被过滤
  ];
  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v && !isInternalAccountNo(v)) return v;
  }
  return '';
}

function resolveBloggerMetricsFromProfilePayload(
  profilePayload = {},
  fallbackProfileUrl = '',
) {
  const safePayload =
    profilePayload && typeof profilePayload === 'object' ? profilePayload : {};
  const rawFollowersCount =
    safePayload.bloggerFollowersCount ?? safePayload.followersCount;
  const rawLikedAndCollectedCount =
    safePayload.bloggerLikedAndCollectedCount ??
    safePayload.likedAndCollectedCount;

  return createBloggerMetricsPatch({
    status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
    followersCount: rawFollowersCount,
    likedAndCollectedCount: rawLikedAndCollectedCount,
    followersCountKnown:
      isExplicitCountValue(rawFollowersCount) &&
      normalizeOptionalCount(rawFollowersCount) !== null,
    likedAndCollectedCountKnown:
      isExplicitCountValue(rawLikedAndCollectedCount) &&
      normalizeOptionalCount(rawLikedAndCollectedCount) !== null,
    profileUrl:
      safePayload.bloggerProfileUrl ||
      safePayload.authorUrl ||
      safePayload.bloggerUrl ||
      fallbackProfileUrl,
    error: '',
    accountType: safePayload.bloggerAccountType || safePayload.accountType,
    bloggerName:
      safePayload.bloggerName ||
      safePayload.authorName ||
      safePayload.author ||
      safePayload.nickname,
    // 只回填「人看的号」,内部 hex / sec_uid 一律不写(宁可空也不写错)
    bloggerId: pickHumanAccountNo(safePayload),
  });
}

function resolveBloggerMetricsPatchFromCurrentPayload(
  payload = {},
  { requireBothMetrics = false } = {},
) {
  const normalizedPayload = ensureBloggerMetricsFields(payload);
  const followersCount = resolveProvenBloggerFollowersCount(payload);
  const likedAndCollectedCount =
    resolveProvenBloggerLikedAndCollectedCount(payload);

  if (requireBothMetrics) {
    if (followersCount === null || likedAndCollectedCount === null) {
      return null;
    }
  } else if (followersCount === null && likedAndCollectedCount === null) {
    return null;
  }

  return createBloggerMetricsPatch({
    status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
    followersCount: followersCount ?? undefined,
    likedAndCollectedCount: likedAndCollectedCount ?? undefined,
    followersCountKnown: followersCount !== null,
    likedAndCollectedCountKnown: likedAndCollectedCount !== null,
    profileUrl:
      normalizedPayload.bloggerProfileUrl ||
      resolveBloggerProfileUrlFromPayload(normalizedPayload),
    error: '',
    accountType:
      normalizedPayload.bloggerAccountType || normalizedPayload.accountType,
    // 抖音号(unique_id,来自作品页 API)→ author_account_no;过滤掉 sec_uid/内部 hex
    bloggerId: pickHumanAccountNo(normalizedPayload),
  });
}

function applyBloggerMetricsResultToPayload(payload, result) {
  if (result?.ok) {
    const patch =
      result.patch ||
      createBloggerMetricsPatch({
        status: BLOGGER_METRICS_CAPTURE_STATUS.DONE,
        error: '',
      });
    return applyBloggerMetricsPatch(payload, patch);
  }

  return applyBloggerMetricsPatch(
    payload,
    createBloggerMetricsPatch({
      status: BLOGGER_METRICS_CAPTURE_STATUS.FAILED,
      error: result?.error || '博主指标采集失败',
      profileUrl: result?.profileUrl,
    }),
  );
}

function resolveBloggerProfileUrlFromPayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const candidates = [base.authorUrl, base.bloggerProfileUrl, base.bloggerUrl];

  for (const candidate of candidates) {
    const normalized = normalizeOpenUrl(candidate);
    if (normalized) return normalized;
  }

  return '';
}

function resolveDetailRecordItemMetricsStatus(item, payload) {
  const itemStatus = String(item?.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  if (isValidBloggerMetricsStatus(itemStatus)) return itemStatus;

  const payloadStatus = String(payload?.bloggerMetricsCaptureStatus || '')
    .trim()
    .toLowerCase();
  if (isValidBloggerMetricsStatus(payloadStatus)) return payloadStatus;

  const hasMetricsData =
    isFiniteNonNegativeNumber(item?.bloggerFollowersCount) ||
    isFiniteNonNegativeNumber(item?.bloggerLikedAndCollectedCount) ||
    isFiniteNonNegativeNumber(payload?.bloggerFollowersCount) ||
    isFiniteNonNegativeNumber(payload?.bloggerLikedAndCollectedCount) ||
    Boolean(
      normalizeBloggerAccountType(
        item?.bloggerAccountType || payload?.bloggerAccountType,
      ),
    );

  if (hasMetricsData) {
    return BLOGGER_METRICS_CAPTURE_STATUS.DONE;
  }

  return BLOGGER_METRICS_CAPTURE_STATUS.NOT_STARTED;
}

function normalizeDetailRecordItem(item, payload) {
  const rawItem = item && typeof item === 'object' ? item : {};
  const rawPayload = payload && typeof payload === 'object' ? payload : {};

  return ensureBloggerMetricsFields(sanitizeListItemForStorage({
    ...rawItem,
    bloggerFollowersCount:
      rawItem.bloggerFollowersCount ??
      rawPayload.bloggerFollowersCount ??
      rawPayload.followersCount,
    bloggerLikedAndCollectedCount:
      rawItem.bloggerLikedAndCollectedCount ??
      rawPayload.bloggerLikedAndCollectedCount ??
      rawPayload.likedAndCollectedCount,
    bloggerProfileUrl:
      rawItem.bloggerProfileUrl || rawItem.authorUrl || rawPayload.bloggerUrl || '',
    bloggerMetricsCaptureStatus: resolveDetailRecordItemMetricsStatus(
      rawItem,
      rawPayload,
    ),
    bloggerMetricsCaptureError:
      String(rawItem.bloggerMetricsCaptureError || rawPayload.bloggerMetricsCaptureError || ''),
    bloggerAccountType: normalizeBloggerAccountType(
      rawItem.bloggerAccountType || rawPayload.bloggerAccountType,
    ),
  }));
}

function truncateStorageString(value, maxLength = 240) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function trimStorageStringList(value, maxItems = 3, maxLength = 360) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => truncateStorageString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeDomLocatorForStorage(locator) {
  if (!locator || typeof locator !== 'object') {
    return locator || null;
  }

  return {
    ...locator,
    className: truncateStorageString(locator.className, 160),
    textSnippet: truncateStorageString(locator.textSnippet, 100),
    cssPath: truncateStorageString(locator.cssPath, 240),
    parentCssPath: truncateStorageString(locator.parentCssPath, 240),
    imageFingerprints: trimStorageStringList(locator.imageFingerprints, 3, 220),
    videoFingerprints: trimStorageStringList(locator.videoFingerprints, 2, 220),
  };
}

function sanitizeDomMatchHintsForStorage(hints) {
  if (!hints || typeof hints !== 'object') {
    return hints || null;
  }

  return {
    ...hints,
    noteUrl: truncateStorageString(hints.noteUrl, 360),
    noteUrlFingerprint: truncateStorageString(hints.noteUrlFingerprint, 220),
    coverImageUrl: truncateStorageString(hints.coverImageUrl, 360),
    coverImageFingerprint: truncateStorageString(
      hints.coverImageFingerprint,
      220,
    ),
    videoUrl: '',
    videoUrlFingerprint: '',
    titleSnippet: truncateStorageString(hints.titleSnippet, 80),
    authorSnippet: truncateStorageString(hints.authorSnippet, 80),
  };
}

function sanitizeListItemForStorage(item) {
  if (!item || typeof item !== 'object') {
    return item || {};
  }

  return {
    ...item,
    videoUrl: '',
    videoUrls: [],
    audioUrl: '',
    audioUrls: [],
    cardImageCandidates: trimStorageStringList(item.cardImageCandidates, 2, 360),
    cardVideoCandidates: [],
    domLocator: sanitizeDomLocatorForStorage(item.domLocator),
    domMatchHints: sanitizeDomMatchHintsForStorage(item.domMatchHints),
  };
}

function isDetailCaptureRecordType(type) {
  return type === SYNC_TYPE.BLOGGER_NOTES || type === SYNC_TYPE.KEYWORD_NOTES;
}

function parseDetailKeywordFilter(raw) {
  return String(raw || '')
    .split(/[,，]/)
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => ({
      value,
      normalized: value.toLowerCase(),
    }))
    .filter((item) => item.normalized);
}

function getFirstPayloadItem(payload) {
  return Array.isArray(payload?.items) && payload.items.length > 0
    ? payload.items[0]
    : {};
}

function getDetailKeywordFilterRules(record) {
  const recordType = record?.type || record?.recordType;
  if (recordType !== SYNC_TYPE.BLOGGER_NOTES) {
    return [];
  }

  const payload = record?.payload && typeof record.payload === 'object'
    ? record.payload
    : {};
  if (String(payload.keywordFilterMode || '').trim() !== 'detail') {
    return [];
  }

  return parseDetailKeywordFilter(payload.keywordFilter);
}

function buildDetailKeywordSearchText(record, detailPayload) {
  const payload = record?.payload && typeof record.payload === 'object'
    ? record.payload
    : {};
  const firstItem = getFirstPayloadItem(payload);
  const tags = Array.isArray(detailPayload?.tags)
    ? detailPayload.tags
    : [];
  return [
    record?.title,
    firstItem?.title,
    firstItem?.content,
    detailPayload?.title,
    detailPayload?.content,
    ...tags,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function evaluateDetailKeywordFilter(record, detailPayload) {
  const rules = getDetailKeywordFilterRules(record);
  if (rules.length === 0) {
    return {
      matched: true,
      keywords: [],
      matchedKeywords: [],
    };
  }

  const searchText = buildDetailKeywordSearchText(record, detailPayload);
  const matchedKeywords = rules
    .filter((rule) => searchText.includes(rule.normalized))
    .map((rule) => rule.value);

  return {
    matched: matchedKeywords.length > 0,
    keywords: rules.map((rule) => rule.value),
    matchedKeywords,
  };
}

function formatDetailKeywordFilterLabel(keywords = []) {
  const normalized = Array.isArray(keywords)
    ? keywords.map((keyword) => String(keyword || '').trim()).filter(Boolean)
    : [];
  if (normalized.length === 0) {
    return '未设置';
  }
  if (normalized.length <= 3) {
    return normalized.join('、');
  }
  return `${normalized.slice(0, 3).join('、')}等 ${normalized.length} 个`;
}

function ensureDetailCaptureFields(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  return {
    ...base,
    detailCaptureStatus:
      base.detailCaptureStatus || DETAIL_CAPTURE_STATUS.NOT_STARTED,
    detailCaptureError: String(base.detailCaptureError || ''),
    detailCaptureFailureCode: String(base.detailCaptureFailureCode || ''),
    detailCaptureFailureStage: String(base.detailCaptureFailureStage || ''),
    detailCaptureFailureCategory: String(base.detailCaptureFailureCategory || ''),
    detailCaptureDiagnosticMessage: String(base.detailCaptureDiagnosticMessage || ''),
    detailCaptureStartedAt: Number(base.detailCaptureStartedAt || 0),
    detailCaptureFinishedAt: Number(base.detailCaptureFinishedAt || 0),
    detailCaptureNoteUrl: String(base.detailCaptureNoteUrl || ''),
    detailPayload:
      base.detailPayload && typeof base.detailPayload === 'object'
        ? ensureBloggerMetricsFields(
            applyCommentStatusToPayload(base.detailPayload, {}),
          )
        : null,
  };
}

function applyDetailCapturePatch(payload, patch) {
  const base = ensureDetailCaptureFields(payload);
  return {
    ...base,
    detailCaptureStatus: patch.detailCaptureStatus ?? base.detailCaptureStatus,
    detailCaptureError: patch.detailCaptureError ?? base.detailCaptureError,
    detailCaptureFailureCode:
      patch.detailCaptureFailureCode ?? base.detailCaptureFailureCode,
    detailCaptureFailureStage:
      patch.detailCaptureFailureStage ?? base.detailCaptureFailureStage,
    detailCaptureFailureCategory:
      patch.detailCaptureFailureCategory ?? base.detailCaptureFailureCategory,
    detailCaptureDiagnosticMessage:
      patch.detailCaptureDiagnosticMessage ?? base.detailCaptureDiagnosticMessage,
    detailCaptureStartedAt:
      patch.detailCaptureStartedAt ?? base.detailCaptureStartedAt,
    detailCaptureFinishedAt:
      patch.detailCaptureFinishedAt ?? base.detailCaptureFinishedAt,
    detailCaptureNoteUrl:
      patch.detailCaptureNoteUrl ?? base.detailCaptureNoteUrl,
    detailPayload:
      patch.detailPayload !== undefined ? patch.detailPayload : base.detailPayload,
  };
}

function createDetailCapturePatch({
  status,
  startedAt = 0,
  finishedAt = 0,
  error = '',
  failureCode = '',
  failureStage = '',
  failureCategory = '',
  diagnosticMessage = '',
  noteUrl = '',
  detailPayload = undefined,
}) {
  return {
    detailCaptureStatus: status,
    detailCaptureError: error,
    detailCaptureFailureCode: failureCode,
    detailCaptureFailureStage: failureStage,
    detailCaptureFailureCategory: failureCategory,
    detailCaptureDiagnosticMessage: diagnosticMessage,
    detailCaptureStartedAt: startedAt,
    detailCaptureFinishedAt: finishedAt,
    detailCaptureNoteUrl: noteUrl,
    detailPayload,
  };
}

function buildDetailCaptureFailure(code, stage, diagnosticMessage = '') {
  const normalizedCode = String(code || DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN)
    .trim()
    .toUpperCase();
  const normalizedStage =
    String(stage || 'unknown').trim().toLowerCase() || 'unknown';
  const normalizedDiagnostic = String(diagnosticMessage || '').trim();

  switch (normalizedCode) {
    case DETAIL_CAPTURE_FAILURE_CODE.LINK_MISSING:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.LINK_MISSING,
        userMessage: '缺少可访问的笔记链接',
        diagnosticMessage: normalizedDiagnostic || '未找到可访问的笔记链接',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_TIMEOUT:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '打开详情页超时，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '打开页面超时，请稍后重试',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '打开详情页失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '打开详情页失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.CONTENT_UNAVAILABLE:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '抖音作品不存在或不可访问，已跳过当前条',
        diagnosticMessage:
          normalizedDiagnostic || '抖音作品不存在、已删除或当前账号不可访问',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.IDENTITY_MISMATCH:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.INTEGRITY_BLOCKED,
        userMessage: '无法确认当前抖音作品身份，已停止以防数据错配',
        diagnosticMessage:
          normalizedDiagnostic || '目标作品 ID 与页面或采集结果不一致',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.NOTE_CAPTURE_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '详情页采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '详情采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '评论采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '评论采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.BLOGGER_METRICS_FAILED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.PAGE_FAILED,
        userMessage: '博主指标采集失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '博主指标采集失败',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.CONTEXT_INTERRUPTED,
        userMessage: '插件窗口或页面已中断，请重新执行采集增强',
        diagnosticMessage: normalizedDiagnostic || '插件上下文或标签页已中断',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.CANCELED:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.USER_CANCELED,
        userMessage: '采集增强已取消',
        diagnosticMessage: normalizedDiagnostic || '采集增强已取消',
      };
    case DETAIL_CAPTURE_FAILURE_CODE.INVALID_RECORD:
      return {
        code: normalizedCode,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.INVALID_RECORD,
        userMessage: '记录无效，无法执行采集增强',
        diagnosticMessage: normalizedDiagnostic || '记录不存在或类型不支持补采详情',
      };
    default:
      return {
        code: normalizedCode || DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN,
        stage: normalizedStage,
        category: DETAIL_CAPTURE_FAILURE_CATEGORY.UNKNOWN,
        userMessage: '采集增强失败，请稍后重试',
        diagnosticMessage: normalizedDiagnostic || '详情补采失败',
      };
  }
}

function isLikelyContextInterruptedMessage(message = '') {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    'detail_capture_canceled',
    'extension context invalidated',
    'receiving end does not exist',
    'message port closed',
    'the tab was closed',
    'no tab with id',
    'tabs cannot be edited right now',
    'cannot access a chrome://',
    'frame with id 0 was removed',
  ].some((token) => normalized.includes(token));
}

function classifyDetailCaptureFailure(error, { stage = 'unknown' } = {}) {
  const rawMessage = String(error?.message || '').trim();
  const rawCode = String(error?.code || '').trim().toUpperCase();
  const normalizedStage =
    String(stage || 'unknown').trim().toLowerCase() || 'unknown';

  if (
    rawCode === 'DOUYIN_CONTENT_UNAVAILABLE' ||
    rawCode === DETAIL_CAPTURE_FAILURE_CODE.CONTENT_UNAVAILABLE
  ) {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.CONTENT_UNAVAILABLE,
      normalizedStage,
      rawMessage,
    );
  }

  if (
    rawCode === 'DOUYIN_DETAIL_ID_MISMATCH' ||
    rawCode === 'DOUYIN_COMMENT_ID_MISMATCH' ||
    rawCode === 'DOUYIN_COMMENT_ID_CONFLICT' ||
    rawCode === DETAIL_CAPTURE_FAILURE_CODE.IDENTITY_MISMATCH
  ) {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.IDENTITY_MISMATCH,
      normalizedStage,
      rawMessage,
    );
  }

  if (isLikelyContextInterruptedMessage(rawMessage)) {
    const interruptedCode =
      rawMessage === 'DETAIL_CAPTURE_CANCELED'
        ? DETAIL_CAPTURE_FAILURE_CODE.CANCELED
        : DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED;
    return buildDetailCaptureFailure(
      interruptedCode,
      normalizedStage,
      rawMessage || '插件上下文或标签页已中断',
    );
  }

  if (normalizedStage === 'navigation') {
    if (rawMessage.includes('超时')) {
      return buildDetailCaptureFailure(
        DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_TIMEOUT,
        normalizedStage,
        rawMessage,
      );
    }
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.PAGE_OPEN_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (
    normalizedStage === 'note_capture' ||
    normalizedStage === 'commit_guard'
  ) {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.NOTE_CAPTURE_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (normalizedStage === 'comments_capture') {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  if (normalizedStage === 'blogger_metrics_capture') {
    return buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.BLOGGER_METRICS_FAILED,
      normalizedStage,
      rawMessage,
    );
  }

  return buildDetailCaptureFailure(
    DETAIL_CAPTURE_FAILURE_CODE.UNKNOWN,
    normalizedStage,
    rawMessage,
  );
}

export async function repairInterruptedDetailCaptureRecords() {
  const dataPool = await getDataPool();
  const records = Array.isArray(dataPool?.records) ? dataPool.records : [];
  const repairedRecordIds = [];

  for (const record of records) {
    if (!record || !isDetailCaptureRecordType(record.type)) {
      continue;
    }

    const payload =
      record.payload && typeof record.payload === 'object' ? record.payload : {};
    const status = String(payload.detailCaptureStatus || '').trim().toLowerCase();
    if (status !== DETAIL_CAPTURE_STATUS.CAPTURING) {
      continue;
    }

    const failure = buildDetailCaptureFailure(
      DETAIL_CAPTURE_FAILURE_CODE.CONTEXT_INTERRUPTED,
      'interrupted',
      '侧栏已关闭、页面已刷新或标签页已切换，导致任务中断',
    );
    const nextPayload = applyDetailCapturePatch(
      payload,
      createDetailCapturePatch({
        status: DETAIL_CAPTURE_STATUS.FAILED,
        startedAt: Number(payload.detailCaptureStartedAt || 0),
        finishedAt: Date.now(),
        error: failure.userMessage,
        failureCode: failure.code,
        failureStage: failure.stage,
        failureCategory: failure.category,
        diagnosticMessage: failure.diagnosticMessage,
        noteUrl: String(payload.detailCaptureNoteUrl || ''),
      }),
    );

    await updateRecord(record.id, {
      status: RECORD_STATUS.DRAFT,
      payload: nextPayload,
    });
    repairedRecordIds.push(record.id);
  }

  return {
    count: repairedRecordIds.length,
    recordIds: repairedRecordIds,
  };
}

export async function repairInterruptedCommentCaptureRecords() {
  const dataPool = await getDataPool();
  const records = Array.isArray(dataPool?.records) ? dataPool.records : [];
  const repairedRecordIds = [];

  for (const record of records) {
    if (!record || !record.id) continue;
    const payload =
      record.payload && typeof record.payload === 'object' ? record.payload : {};
    let nextPayload = payload;
    let changed = false;

    if (record.type === SYNC_TYPE.SINGLE_NOTE) {
      const repaired = repairInterruptedCommentPayload(payload);
      nextPayload = repaired.payload;
      changed = repaired.changed;
    } else if (
      isDetailCaptureRecordType(record.type) &&
      payload.detailPayload &&
      typeof payload.detailPayload === 'object'
    ) {
      const repaired = repairInterruptedCommentPayload(payload.detailPayload);
      if (repaired.changed) {
        nextPayload = {
          ...payload,
          detailPayload: repaired.payload,
        };
        changed = true;
      }
    }

    if (!changed) continue;
    await updateRecord(record.id, {
      status: RECORD_STATUS.DRAFT,
      payload: nextPayload,
    });
    repairedRecordIds.push(record.id);
  }

  return {
    count: repairedRecordIds.length,
    recordIds: repairedRecordIds,
  };
}

function resolveRecordNoteUrl(record) {
  if (!record || !record.payload || typeof record.payload !== 'object') {
    return '';
  }

  const payload = record.payload;
  const firstItem = Array.isArray(payload.items) ? payload.items[0] : null;
  const expectedNoteId = resolveRecordDetailNoteId(record);
  const capturedCandidates = [
    firstItem?.url,
    firstItem?.noteUrl,
    firstItem?.detailPageUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
  ];
  const isDouyinRecord =
    String(record?.platform || '').trim().toLowerCase() === 'douyin' ||
    capturedCandidates.some(
      (candidate) =>
        detectPlatformFromUrl(String(candidate || '')) === 'douyin',
    );

  if (isDouyinRecord) {
    if (!/^\d{8,}$/.test(String(expectedNoteId || ''))) {
      return '';
    }
    const preferredPath = resolveRecordDetailNotePath(record);
    const directPath =
      preferredPath === 'note' || preferredPath === 'video'
        ? preferredPath
        : 'video';
    return `https://www.douyin.com/${directPath}/${expectedNoteId}`;
  }

  const candidates = [
    ...capturedCandidates,
    buildFallbackDetailNoteUrl(record),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOpenUrl(candidate);
    if (normalized) {
      const candidateNoteId = extractNoteId(normalized);
      if (
        expectedNoteId &&
        candidateNoteId &&
        candidateNoteId !== expectedNoteId
      ) {
        continue;
      }
      return normalizeDouyinDetailUrlAgainstRecord(record, normalized);
    }
  }

  return '';
}

function buildFallbackDetailNoteUrl(record) {
  const noteId = resolveRecordDetailNoteId(record);
  if (!noteId) {
    return '';
  }

  const platform = String(record?.platform || '').trim().toLowerCase();
  if (platform === 'douyin') {
    const resolvedPath = resolveRecordDetailNotePath(record);
    const directPath =
      resolvedPath === 'note' || resolvedPath === 'video'
        ? resolvedPath
        : 'video';
    return `https://www.douyin.com/${directPath}/${noteId}`;
  }
  if (platform === 'weibo') {
    // 数字 mid 直接走 /detail/<mid>(show/buildComments 都吃数字 mid)
    return `https://weibo.com/detail/${noteId}`;
  }

  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function buildDouyinRecordSearchModalUrl(record, noteId) {
  if (!/^\d{8,}$/.test(String(noteId || ''))) {
    return '';
  }
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) &&
    payload.items[0] &&
    typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const candidates = [
    firstItem.searchUrl,
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.searchUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
    record?.meta?.sourceUrl,
    record?.sourceUrl,
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(String(candidate || ''));
      const host = parsed.hostname.toLowerCase();
      if (
        (host !== 'douyin.com' && !host.endsWith('.douyin.com')) ||
        !/\/search\//i.test(parsed.pathname)
      ) {
        continue;
      }
      parsed.searchParams.set('modal_id', String(noteId));
      return parsed.toString();
    } catch {
      // Try the next captured search context.
    }
  }
  return '';
}

export function inspectDouyinRecordDetailIdentity(record) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const urlCandidates = [
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
  ];
  const isDouyinRecord =
    String(record?.platform || '').trim().toLowerCase() === 'douyin' ||
    urlCandidates.some(
      (value) => detectPlatformFromUrl(String(value || '')) === 'douyin',
    );
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    ...urlCandidates.map(extractNoteId),
  ];
  const noteIds = Array.from(
    new Set(
      candidates
        .map((candidate) => String(candidate || '').trim())
        .filter(
          (candidate) =>
            /^\d{8,}$/.test(candidate) &&
            !candidate.startsWith('synthetic_'),
        ),
    ),
  );

  return {
    isDouyin: isDouyinRecord,
    noteId:
      isDouyinRecord && noteIds.length === 1
        ? noteIds[0]
        : '',
    noteIds: isDouyinRecord ? noteIds : [],
    conflicting: isDouyinRecord && noteIds.length > 1,
  };
}

export function resolveRecordDetailNoteId(record) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const urlCandidates = [
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
  ];
  const candidates = [
    firstItem.noteId,
    payload.noteId,
    firstItem.id,
    payload.id,
    ...urlCandidates.map(extractNoteId),
  ];
  const douyinIdentity = inspectDouyinRecordDetailIdentity(record);

  if (douyinIdentity.isDouyin) {
    // A direct-first URL must never be synthesized from one side of a
    // self-contradictory record. Let the caller fail closed instead.
    return douyinIdentity.noteId;
  }

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized || normalized.startsWith('synthetic_')) {
      continue;
    }
    if (/^[a-zA-Z0-9_-]{6,}$/.test(normalized)) {
      return normalized;
    }
  }

  return '';
}

export function resolveRecordDetailNotePath(record) {
  const payload =
    record?.payload && typeof record.payload === 'object'
      ? record.payload
      : {};
  const firstItem =
    Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object'
      ? payload.items[0]
      : {};
  const directUrls = [
    firstItem.url,
    firstItem.noteUrl,
    firstItem.detailPageUrl,
    payload.detailCaptureNoteUrl,
    payload.url,
    payload.noteUrl,
    payload.detailPageUrl,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const hasDirectNotePath = directUrls.some((value) =>
    /\/note\/\d{8,}/i.test(value),
  );
  const hasDirectVideoPath = directUrls.some((value) =>
    /\/video\/\d{8,}/i.test(value),
  );
  if (hasDirectNotePath && hasDirectVideoPath) {
    return 'unknown';
  }
  if (hasDirectNotePath) {
    return 'note';
  }
  if (hasDirectVideoPath) {
    return 'video';
  }
  const rawType = String(
    firstItem.noteType ||
      firstItem.type ||
      payload.noteType ||
      payload.type ||
      '',
  )
    .trim()
    .toLowerCase();

  if (
    rawType === 'image' ||
    rawType === 'images' ||
    rawType === 'image_text' ||
    rawType === '图文'
  ) {
    return 'note';
  }
  const duration = String(
    firstItem.duration ||
      firstItem.videoDuration ||
      payload.duration ||
      payload.videoDuration ||
      '',
  ).trim();
  if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(duration)) {
    return 'video';
  }
  if (
    rawType === 'video' &&
    duration
  ) {
    return 'video';
  }

  return 'unknown';
}

function normalizeDouyinDetailUrlAgainstRecord(record, url) {
  const normalized = String(url || '').trim();
  const platform = String(
    record?.platform || detectPlatformFromUrl(normalized),
  )
    .trim()
    .toLowerCase();
  if (
    platform !== 'douyin' ||
    resolveRecordDetailNotePath(record) !== 'video'
  ) {
    return normalized;
  }

  try {
    const parsed = new URL(normalized);
    const match = parsed.pathname.match(/^\/note\/([^/?#]+)/i);
    if (!match?.[1]) return normalized;
    parsed.pathname = `/video/${match[1]}`;
    return parsed.toString();
  } catch {
    return normalized.replace(
      /^(https?:\/\/(?:www\.)?douyin\.com)\/note\//i,
      '$1/video/',
    );
  }
}

export function buildDouyinDetailNavigationCandidates(
  targetUrl,
  sourcePageUrl = '',
  preferredPath = 'unknown',
) {
  const normalizedTarget = normalizeOpenUrl(targetUrl);
  if (!normalizedTarget || detectPlatformFromUrl(normalizedTarget) !== 'douyin') {
    return normalizedTarget ? [normalizedTarget] : [];
  }

  const noteId = extractNoteId(normalizedTarget);
  if (!/^\d{8,}$/.test(String(noteId || ''))) {
    return [normalizedTarget];
  }
  const normalizedPreferredPath = String(preferredPath || '')
    .trim()
    .toLowerCase();
  const directPaths =
    normalizedPreferredPath === 'note'
      ? ['note']
      : normalizedPreferredPath === 'video'
        ? ['video']
        : ['video', 'note'];

  const candidates = [];
  const push = (value) => {
    const normalized = normalizeOpenUrl(value);
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  for (const directPath of directPaths) {
    push(`https://www.douyin.com/${directPath}/${noteId}`);
  }

  const modalCandidates = [normalizedTarget, sourcePageUrl];
  for (const modalCandidate of modalCandidates) {
    try {
      const parsed = new URL(String(modalCandidate || ''));
      const host = parsed.hostname.toLowerCase();
      const modalId = parsed.searchParams.get('modal_id') || '';
      const isMatchingDouyinSearchModal =
        (host === 'douyin.com' || host.endsWith('.douyin.com')) &&
        /\/search\//i.test(parsed.pathname) &&
        modalId === noteId;
      if (isMatchingDouyinSearchModal) {
        push(parsed.toString());
      }
    } catch {
      // Ignore malformed or unrelated fallback contexts.
    }
  }

  return candidates;
}

export function buildDouyinCommentRecoveryCandidates(
  record,
  targetUrl,
  sourcePageUrl = '',
) {
  const noteId = resolveRecordDetailNoteId(record) || extractNoteId(targetUrl);
  if (!/^\d{8,}$/.test(String(noteId || ''))) {
    return buildDouyinDetailNavigationCandidates(
      targetUrl,
      sourcePageUrl,
      resolveRecordDetailNotePath(record),
    );
  }

  const preferredPath = resolveRecordDetailNotePath(record);
  const candidates = [];
  const push = (value) => {
    const normalized = normalizeOpenUrl(value);
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  // 评论开始前若搜索弹层已经消失，继续留在搜索页只会得到“详情元素不存在”。
  // 恢复阶段先走明确绑定作品 ID 的直达页，再回退到搜索弹层上下文。
  buildDouyinDetailNavigationCandidates(
    targetUrl,
    sourcePageUrl,
    preferredPath,
  ).forEach(push);
  return candidates;
}

function normalizeOpenUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  let normalized = raw;
  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }
  if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:\/\//i, 'https://');
  }

  try {
    const parsed = new URL(normalized, 'https://www.xiaohongshu.com');
    if (!isSupportedCaptureHostname(parsed.hostname)) {
      return '';
    }
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function isSupportedCaptureHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (!normalized) return false;

  return (
    normalized === 'xiaohongshu.com' ||
    normalized.endsWith('.xiaohongshu.com') ||
    normalized === 'douyin.com' ||
    normalized.endsWith('.douyin.com') ||
    normalized === 'weibo.com' ||
    normalized.endsWith('.weibo.com')
  );
}

function buildDetailCapturePreview(record, detailPayload) {
  const baseTitle = String(record?.title || '').trim();
  const detailTitle = String(detailPayload?.title || '').trim();
  const detailTextVerified =
    String(detailPayload?.contentCompleteness || '').trim().toLowerCase() === 'complete' ||
    String(detailPayload?.contentSource || '').trim().toLowerCase() === 'api_detail';
  const title = (
    String(record?.platform || '').trim().toLowerCase() === 'douyin' &&
    !detailTextVerified
      ? pickMoreCompleteCapturedText(baseTitle, detailTitle)
      : detailTitle || baseTitle
  ) || '笔记详情';
  const author = String(detailPayload?.author || '').trim();
  const likes = Number(detailPayload?.likes || 0);
  const summary = author ? `${author} · 点赞 ${likes}` : `点赞 ${likes}`;

  return {
    title,
    summary,
  };
}

async function getCurrentActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('未找到当前活动标签页');
  }
  return tab;
}

async function prepareDetailBatchRunnerContext({
  sourceTab,
  runnerMode = DETAIL_RUNNER_MODE.SOURCE_TAB,
  indexOffset = 1,
} = {}) {
  const sourceTabId = Number(sourceTab?.id);
  if (!Number.isFinite(sourceTabId) || sourceTabId <= 0) {
    throw new Error('未找到可用的来源标签页');
  }

  const sourcePageUrl = String(sourceTab?.url || '');
  const sourcePageScrollY = await getTabScrollY(sourceTabId);
  const sourcePlatform = detectPlatformFromUrl(sourcePageUrl);
  const sourcePageType = detectPageType(sourcePageUrl);
  const shouldKeepLastDetailPageOpen =
    sourcePlatform === 'douyin' &&
    sourcePageType === PAGE_TYPE.BLOGGER_PROFILE;

  const normalizedRunnerMode = normalizeDetailRunnerMode(runnerMode);
  if (normalizedRunnerMode === DETAIL_RUNNER_MODE.DEDICATED_TAB) {
    const runnerTab = await createDedicatedDetailRunnerTab({
      sourceTab,
      indexOffset,
    });
    return {
      sourceTabId,
      sourcePageUrl,
      sourcePageScrollY,
      sourcePlatform,
      sourcePageType,
      runnerMode: normalizedRunnerMode,
      runnerTabId: Number(runnerTab.id),
      openTabAsActive: false,
      ownsRunnerTab: true,
      shouldRestoreSourcePage: false,
      shouldRestoreRuntimeContext: false,
    };
  }

  return {
    sourceTabId,
    sourcePageUrl,
    sourcePageScrollY,
    sourcePlatform,
    sourcePageType,
    runnerMode: normalizedRunnerMode,
    runnerTabId: sourceTabId,
    openTabAsActive: true,
    ownsRunnerTab: false,
    shouldRestoreSourcePage: !shouldKeepLastDetailPageOpen,
    shouldRestoreRuntimeContext: shouldKeepLastDetailPageOpen,
  };
}

// 小红书笔记详情 URL 必须带非空 xsec_source(搜索结果卡片来的是 pc_search)。
// 采集时这个值常被弄成空 → 工具直开「?xsec_token=X&xsec_source=」会被判 300013(访问频繁/安全限制),
// 而人手点进去是同一个 token 但带 xsec_source=pc_search 就正常。这里在导航前补齐(token 不动)。
function ensureXhsNoteUrlSource(targetUrl) {
  try {
    const u = new URL(String(targetUrl));
    const host = u.hostname.toLowerCase();
    if (host !== 'xiaohongshu.com' && !host.endsWith('.xiaohongshu.com')) {
      return targetUrl;
    }
    if (!/\/(?:explore|search_result|discovery\/item|note|video)\/[A-Za-z0-9_-]+/.test(u.pathname)) {
      return targetUrl; // 只修笔记详情,不动主页/搜索页等
    }
    if (u.searchParams.get('xsec_token') && !u.searchParams.get('xsec_source')) {
      u.searchParams.set('xsec_source', 'pc_search');
    }
    return u.toString();
  } catch {
    return targetUrl;
  }
}

async function openUrlInTab(
  tabId,
  targetUrl,
  {
    timeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    shouldStop = null,
    active = true,
  } = {},
) {
  const navUrl = ensureXhsNoteUrlSource(targetUrl);

  await chrome.tabs.update(tabId, {
    url: navUrl,
    active: Boolean(active),
  });

  await waitForOpenedUrlInTab(tabId, targetUrl, {
    timeoutMs,
    shouldStop,
  });
}

async function waitForOpenedUrlInTab(
  tabId,
  targetUrl,
  {
    timeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS,
    shouldStop = null,
  } = {},
) {
  const targetNoteId = extractNoteId(targetUrl);
  const requiresDouyinTargetIdentity =
    Boolean(targetNoteId) && isDouyinContentFlowUrl(targetUrl);
  const startedAt = Date.now();
  let douyinTargetMatchedAt = 0;
  let lastObservedUrl = '';
  while (Date.now() - startedAt < timeoutMs) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('DETAIL_CAPTURE_CANCELED');
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(error?.message || '读取标签页状态失败');
    }

    const currentUrl = String(tab?.url || '');
    lastObservedUrl = currentUrl;
    const status = String(tab?.status || '');
    const currentNoteId = extractNoteId(currentUrl);
    const targetIdentityMatched =
      !requiresDouyinTargetIdentity || currentNoteId === targetNoteId;
    const noteMatched =
      targetIdentityMatched &&
      isTargetNoteOpened(currentUrl, targetUrl, targetNoteId);
    if (status === 'complete' && noteMatched) {
      return;
    }
    if (requiresDouyinTargetIdentity && targetIdentityMatched) {
      if (!douyinTargetMatchedAt) {
        douyinTargetMatchedAt = Date.now();
      }
      if (Date.now() - douyinTargetMatchedAt >= DOUYIN_DETAIL_ROUTE_SETTLE_MS) {
        return;
      }
    } else {
      douyinTargetMatchedAt = 0;
    }

    await waitMs(DETAIL_CAPTURE_NAV_POLL_MS);
  }

  const error = new Error('打开页面超时，请稍后重试');
  error.code = 'DETAIL_NAVIGATION_TIMEOUT';
  error.currentUrl = lastObservedUrl;
  throw error;
}

async function probeDetailPreloadSafety(
  tabId,
  {
    targetUrl = '',
    waitForDouyinReady = false,
    requireVisibleDetailRoot = false,
    shouldStop = null,
    timeoutMs = 8000,
  } = {},
) {
  if (!globalThis.chrome?.scripting?.executeScript) {
    if (waitForDouyinReady) {
      const error = new Error('当前浏览器无法确认抖音详情页是否加载完成');
      error.code = 'DOUYIN_DETAIL_NOT_READY';
      throw error;
    }
    return {ok: true, skipped: true};
  }
  const expectedNoteId = extractNoteId(targetUrl);
  const startedAt = Date.now();
  let unavailableSince = 0;
  let unboundSearchModalSince = 0;
  try {
    while (true) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        throw new Error('DETAIL_CAPTURE_CANCELED');
      }
      const [execution] = await chrome.scripting.executeScript({
        target: {tabId: Number(tabId)},
        args: [
          String(expectedNoteId || ''),
          Boolean(requireVisibleDetailRoot),
          XHS_SECURITY_PAGE_MARKERS,
        ],
        func: (targetNoteId, requireVisibleRoot, xhsMarkers) => {
          const title = String(document.title || '').trim();
          const bodyText = String(document.body?.innerText || '')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, 12000);
          const currentUrl = String(location.href || '');
          const douyinUnavailableCopy =
            /你要观看的(?:图文|视频|作品|内容)不存在/u.test(
              `${title} ${bodyText}`,
            );
          const douyinUnavailableAction =
            /接下来播放|去精选页查看更多(?:视频|内容)|返回精选/u.test(
              bodyText,
            );
          const douyinExactUnavailableCopy =
            /^你要观看的(?:图文|视频|作品|内容)不存在[。！？]?$/u.test(
              bodyText,
            );
          const douyinImmediateUnavailable =
            douyinUnavailableCopy &&
            (douyinUnavailableAction || douyinExactUnavailableCopy);
          const douyinUnavailable =
            douyinImmediateUnavailable ||
            /(?:图文|视频|作品|内容)不存在|该作品已删除|内容已下架/u.test(
              `${title} ${bodyText}`,
            );
          const normalizedPageText = `${title} ${bodyText}`
            .replace(/[\u2010-\u2015]/gu, '-')
            .replace(/[\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f"']/gu, '')
            .replace(/\s+/gu, ' ')
            .trim()
            .toLowerCase();
          const xhsChineseBlocked =
            normalizedPageText.includes(xhsMarkers.chineseTitle) &&
            normalizedPageText.includes(xhsMarkers.chineseRateLimit) &&
            normalizedPageText.includes(xhsMarkers.chineseRetry) &&
            (
              normalizedPageText.includes(xhsMarkers.chineseCode) ||
              xhsMarkers.chineseActions.every((action) =>
                normalizedPageText.includes(action),
              )
            );
          const xhsEnglishQrBlocked =
            normalizedPageText.includes(xhsMarkers.englishQrLead) &&
            normalizedPageText.includes(xhsMarkers.englishQrReason);
          const xhsEnglishRateBlocked =
            normalizedPageText.includes(xhsMarkers.englishRateLimit) &&
            normalizedPageText.includes(xhsMarkers.englishRetry);
          const xhsSecurityEvidence = xhsChineseBlocked
            ? {
                confirmed: true,
                platform: 'xiaohongshu',
                variant: 'cn_rate_limit_300013',
                language: 'zh-CN',
                reason: 'rate_limit',
                pageUrl: currentUrl,
              }
            : xhsEnglishQrBlocked
              ? {
                  confirmed: true,
                  platform: 'xiaohongshu',
                  variant: 'en_account_security_qr',
                  language: 'en',
                  reason: 'account_security_qr',
                  pageUrl: currentUrl,
                }
              : xhsEnglishRateBlocked
                ? {
                    confirmed: true,
                    platform: 'xiaohongshu',
                    variant: 'en_rate_limit',
                    language: 'en',
                    reason: 'rate_limit',
                    pageUrl: currentUrl,
                  }
                : null;
          const xhsBlocked = Boolean(xhsSecurityEvidence);
          const isXiaohongshu = /(^|\.)xiaohongshu\.com$/i.test(
            location.hostname,
          );
          const normalizeChallengeText = (value) =>
            String(value || '').trim().replace(/\s+/gu, '');
          const isChallengeCopy = (value) => {
            const normalized = normalizeChallengeText(value);
            return (
              /请完成下列验证后继续[:：]?/iu.test(normalized) ||
              (
                /请选择所有符合(?:上文|上述|下列)?描述的图片/iu.test(
                  normalized,
                ) &&
                /(?:并)?拖拽到(?:下方|这里)/iu.test(normalized)
              )
            );
          };
          const isVisibleChallengeNode = (node) => {
            if (!(node instanceof Element)) return false;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return Boolean(
              rect.width > 4 &&
                rect.height > 4 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || 1) > 0.01,
            );
          };
          const structuredChallengeSelectors = [
            '[role="dialog"]',
            'dialog',
            '[id*="captcha" i]',
            '[id*="verify" i]',
            '[class*="captcha" i]',
            '[class*="verify" i]',
            '[class*="challenge" i]',
            '[data-e2e*="captcha" i]',
            '[data-testid*="captcha" i]',
          ].join(',');
          const structuredChallengeNodes = Array.from(
            document.querySelectorAll(structuredChallengeSelectors),
          );
          for (const canvas of document.querySelectorAll('canvas')) {
            const container = canvas.closest?.(
              '[role="dialog"], dialog, section, aside, div',
            );
            if (container && !structuredChallengeNodes.includes(container)) {
              structuredChallengeNodes.push(container);
            }
          }
          const semanticChallenge = structuredChallengeNodes.some(
            (node) =>
              isVisibleChallengeNode(node) &&
              isChallengeCopy(node.innerText || node.textContent || ''),
          );
          const challengeFrame = Array.from(
            document.querySelectorAll('iframe'),
          ).some((frame) => {
            if (!isVisibleChallengeNode(frame)) return false;
            const evidence = normalizeChallengeText(
              [
                frame.getAttribute?.('src'),
                frame.getAttribute?.('title'),
                frame.getAttribute?.('name'),
                frame.id,
                frame.className,
              ].join(' '),
            ).toLowerCase();
            return /captcha|verify|verification|challenge/iu.test(evidence);
          });
          const exactChallengeTitle = /^(?:验证码中间页|抖音验证码中间页)$/iu.test(
            normalizeChallengeText(title),
          );
          const challengeBlocked =
            !isXiaohongshu &&
            (exactChallengeTitle || semanticChallenge || challengeFrame);
          const isDouyin = /(^|\.)douyin\.com$/i.test(location.hostname);
          const douyinRateLimitPattern =
            /(?:访问|请求|操作).{0,12}(?:过于?频繁|频繁|过多)|too many requests|(?:http|status|code|状态码|错误码)\s*[:：]?\s*429\b/iu;
          const douyinRateLimitCopy =
            isDouyin &&
            douyinRateLimitPattern.test(`${title} ${bodyText}`);
          const routeMatch = location.pathname.match(
            /\/(?:video|note)\/(\d{8,})/i,
          );
          const modalId =
            new URLSearchParams(location.search).get('modal_id') || '';
          const currentNoteId =
            routeMatch?.[1] ||
            modalId ||
            '';
          const targetMatched =
            !targetNoteId || currentNoteId === targetNoteId;
          const isDirectDetailRoute = Boolean(routeMatch?.[1]);
          const isSearchModalContext = Boolean(
            targetNoteId &&
              modalId === targetNoteId &&
              /\/search\//i.test(location.pathname),
          );
          const isVisible = (element) => {
            if (!(element instanceof Element)) return false;
            if (document.visibilityState === 'hidden') return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return Boolean(
              rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || 1) > 0,
            );
          };
          const hasVisible = (selectors, root = document) => {
            if (!root?.querySelectorAll) return false;
            return selectors.some((selector) =>
              Array.from(root.querySelectorAll(selector)).some(isVisible),
            );
          };
          let apiDetailReady = false;
          if (isDouyin && targetNoteId) {
            for (const storage of [sessionStorage, localStorage]) {
              try {
                const raw = storage.getItem(`__mc_dy_detail_${targetNoteId}`);
                const parsed = raw ? JSON.parse(raw) : null;
                if (parsed?.detail && typeof parsed.detail === 'object') {
                  const embeddedIds = [
                    parsed.detail.aweme_id,
                    parsed.detail.id,
                  ]
                    .filter(
                      (value) => value !== undefined && value !== null,
                    )
                    .map((value) => String(value).trim())
                    .filter(Boolean);
                  if (
                    embeddedIds.length > 0 &&
                    embeddedIds.every((value) => value === targetNoteId)
                  ) {
                    apiDetailReady = true;
                    break;
                  }
                }
              } catch {
                // Continue with visible DOM readiness.
              }
            }
          }
          const targetSelectors = targetNoteId
            ? [
                `[data-e2e-aweme-id="${targetNoteId}"]`,
                `[data-aweme-id="${targetNoteId}"]`,
                `[data-awemeid="${targetNoteId}"]`,
                `[data-item-id="${targetNoteId}"]`,
              ]
            : [];
          const targetRoots = Array.from(
            new Set(
              targetSelectors.flatMap((selector) =>
                Array.from(document.querySelectorAll(selector)),
              ),
            ),
          );
          const readBoundWorkId = (node) => {
            if (!(node instanceof Element)) return '';
            const identityNode =
              node.closest?.(
                '[data-e2e-aweme-id],[data-aweme-id],[data-awemeid],[data-item-id]',
              ) || node;
            for (const attributeName of [
              'data-e2e-aweme-id',
              'data-aweme-id',
              'data-awemeid',
              'data-item-id',
            ]) {
              const value = String(
                identityNode.getAttribute?.(attributeName) || '',
              ).trim();
              if (/^\d{8,}$/.test(value)) return value;
            }
            const descendant = identityNode.querySelector?.(
              '[data-e2e-aweme-id],[data-aweme-id],[data-awemeid],[data-item-id]',
            );
            if (descendant && descendant !== identityNode) {
              return readBoundWorkId(descendant);
            }
            return '';
          };
          const activeWorkIds = new Set();
          for (const selector of [
            '.swiper-slide-active[data-e2e-aweme-id]',
            '.swiper-slide-active [data-e2e-aweme-id]',
            '.swiper-slide-active[data-aweme-id]',
            '.swiper-slide-active [data-aweme-id]',
            '.swiper-slide-active[data-awemeid]',
            '.swiper-slide-active [data-awemeid]',
            '.swiper-slide-active[data-item-id]',
            '.swiper-slide-active [data-item-id]',
            '[role="dialog"] .swiper-slide-active',
            '.focusPanel .swiper-slide-active',
            '[class*="focusPanel"] .swiper-slide-active',
          ]) {
            for (const node of Array.from(document.querySelectorAll(selector))) {
              if (!isVisible(node)) continue;
              const workId = readBoundWorkId(node);
              if (workId) activeWorkIds.add(workId);
            }
          }
          const conflictingActiveWorkIds = targetNoteId
            ? [...activeWorkIds].filter((workId) => workId !== targetNoteId)
            : [];
          const activeWorkIdentityConflict =
            isDouyin && conflictingActiveWorkIds.length > 0;
          const modalBoundarySelector = [
            '[role="dialog"]',
            '[class*="Modal"]',
            '[class*="modal"]',
            '.focusPanel',
            '[class*="focusPanel"]',
          ].join(',');
          const visibleModalRoots = Array.from(
            document.querySelectorAll(modalBoundarySelector),
          ).filter(isVisible);
          const targetModalRoot =
            targetRoots
              .map((root) => root.closest?.(modalBoundarySelector))
              .find((root) => isVisible(root)) || null;
          const linkedModalRoot = targetNoteId
            ? visibleModalRoots.find((root) => {
                return Array.from(
                  root.querySelectorAll(
                    'a[href*="/video/"], a[href*="/note/"]',
                  ),
                ).some((link) => {
                  try {
                    return new URL(
                      link.getAttribute('href') || '',
                      location.origin,
                    ).pathname.match(/\/(?:video|note)\/(\d{8,})/i)?.[1] ===
                      targetNoteId;
                  } catch {
                    return false;
                  }
                });
              }) || null
            : null;
          // 抖音搜索弹层经常只有 URL 的 modal_id 能证明作品身份，弹层 DOM
          // 本身并不带 data-aweme-id，也不一定含作品直达链接。此时只在
          // modal_id 已严格等于目标 ID，且可见弹层内确有详情/评论信号时
          // 接受该弹层；绝不退回搜索页 document，避免把普通推荐卡当详情。
          const modalIdentityFallbackRoot = isSearchModalContext
            ? visibleModalRoots.find((root) =>
                hasVisible(
                  [
                    '[data-e2e="video-desc"]',
                    '[data-e2e="video-info"]',
                    '[data-e2e="feed-video-nickname"]',
                    '[data-e2e="feed-comment-icon"]',
                    '[data-e2e="video-comment-icon"]',
                    '[data-e2e="video-player-comment"]',
                    '[data-e2e="comment-list"]',
                    '.comment-mainContent',
                    'video',
                    '.xgplayer',
                    '[class*="xgplayer"]',
                    'img[src*="douyinpic.com"]',
                    'img[src*="byteimg.com"]',
                  ],
                  root,
                ),
              ) || null
            : null;
          const boundDetailRoot = isSearchModalContext
            ? targetModalRoot ||
              linkedModalRoot ||
              modalIdentityFallbackRoot
            : targetRoots.find((root) => isVisible(root)) ||
              (isDirectDetailRoute ? document : null);
          const detailRoot = boundDetailRoot;
          const hasTitleOrContent = hasVisible(
            [
              '[data-e2e="video-desc"]',
              '[data-e2e="video-info"]',
              '.video-info-detail',
              '[class*="video-desc"]',
              '[class*="VideoDesc"]',
            ],
            detailRoot,
          );
          const hasAuthor = hasVisible(
            [
              '[data-e2e="feed-video-nickname"]',
              '[data-e2e="video-info"] a[href*="/user/"]',
              '.video-info-detail a[href*="/user/"]',
              '[data-e2e="video-avatar"]',
            ],
            detailRoot,
          );
          const hasMedia = hasVisible(
            [
              'video',
              '.xgplayer',
              '[class*="xgplayer"]',
              '.swiper-slide img',
              'main img[src*="douyinpic.com"]',
              'main img[src*="byteimg.com"]',
            ],
            detailRoot,
          );
          const hasEngagement = hasVisible(
            [
              '[data-e2e="video-player-digg"]',
              '[data-e2e="feed-like-icon"]',
              '[data-e2e="feed-comment-icon"]',
              '[data-e2e="video-player-collect"]',
            ],
            detailRoot,
          );
          const hasVisibleDetailSignal = Boolean(
            hasTitleOrContent || hasAuthor || hasMedia || hasEngagement,
          );
          const visibleRateLimitSurface = isDouyin
            ? Array.from(
                document.querySelectorAll(
                  [
                    '[role="alert"]',
                    '[aria-live="assertive"]',
                    '[class*="toast"]',
                    '[class*="Toast"]',
                    '[class*="error"]',
                    '[class*="Error"]',
                    '[class*="exception"]',
                    '[class*="Exception"]',
                    '[role="dialog"]',
                  ].join(','),
                ),
              ).some((surface) => {
                if (!isVisible(surface)) return false;
                const surfaceText = String(surface.innerText || '')
                  .replace(/\s+/gu, ' ')
                  .trim()
                  .slice(0, 800);
                if (
                  !surfaceText ||
                  !douyinRateLimitPattern.test(surfaceText)
                ) {
                  return false;
                }
                // A detail modal may contain those words as ordinary post
                // content. Treat a dialog as an error surface only when the
                // dialog itself has no visible detail/media controls.
                return !hasVisible(
                  [
                    '[data-e2e="video-desc"]',
                    '[data-e2e="video-info"]',
                    '[data-e2e="feed-video-nickname"]',
                    '[data-e2e="feed-comment-icon"]',
                    '[data-e2e="video-player-digg"]',
                    'video',
                    '.xgplayer',
                    '[class*="xgplayer"]',
                  ],
                  surface,
                );
              })
            : false;
          // Normal post text may legitimately mention “操作频繁” or contain
          // the number 429. A visible alert/toast/error overlay remains fatal
          // even when the already-rendered detail is still visible beneath it.
          const douyinRateLimited = Boolean(
            visibleRateLimitSurface ||
              (douyinRateLimitCopy && !hasVisibleDetailSignal),
          );
          const detailReady = Boolean(
            !isDouyin ||
              (targetMatched &&
                !activeWorkIdentityConflict &&
                (isSearchModalContext
                  ? Boolean(boundDetailRoot) &&
                    ((hasMedia &&
                      (hasTitleOrContent || hasAuthor || hasEngagement)) ||
                      (hasTitleOrContent &&
                        (hasAuthor || hasEngagement)))
                  : (!requireVisibleRoot && apiDetailReady) ||
                    (Boolean(boundDetailRoot) &&
                      ((hasMedia &&
                        (hasTitleOrContent || hasAuthor || hasEngagement)) ||
                        (hasTitleOrContent &&
                          (hasAuthor || hasEngagement)))))),
          );
          return {
            currentUrl,
            title,
            isDouyin,
            currentNoteId,
            targetMatched,
            activeWorkIds: [...activeWorkIds],
            conflictingActiveWorkIds,
            activeWorkIdentityConflict,
            detailReady,
            apiDetailReady,
            requireVisibleDetailRoot: requireVisibleRoot,
            hasBoundDetailRoot: Boolean(boundDetailRoot),
            usedModalIdentityFallback: Boolean(
              modalIdentityFallbackRoot &&
                boundDetailRoot === modalIdentityFallbackRoot,
            ),
            isSearchModalContext,
            blocked: xhsBlocked || douyinRateLimited || challengeBlocked,
            unavailable: douyinUnavailable,
            immediateUnavailable: douyinImmediateUnavailable,
            code: xhsBlocked
              ? 'XHS_SECURITY_BLOCK'
              : douyinRateLimited
                ? 'RATE_LIMITED'
              : challengeBlocked
                ? 'PAGE_CHALLENGE_BLOCK'
                : '',
            message: xhsBlocked
              ? xhsSecurityEvidence.reason === 'account_security_qr'
                ? '小红书要求扫码完成账号安全验证，已暂停采集'
                : '小红书提示访问频繁，已暂停采集'
              : douyinRateLimited
                ? '抖音提示访问或操作频繁，已停止继续请求'
              : challengeBlocked
                ? '详情预加载遇到验证码或风险验证页'
                : '',
            securityEvidence: xhsSecurityEvidence,
          };
        },
      });
      const result = execution?.result || {};
      if (result.blocked) {
        const error = result.securityEvidence?.confirmed === true
          ? createXhsSecurityBlockError(result.securityEvidence)
          : new Error(result.message || '详情预加载遇到安全验证页');
        error.code = result.code || error.code || 'PAGE_CHALLENGE_BLOCK';
        error.currentUrl = result.currentUrl || '';
        throw error;
      }
      if (!waitForDouyinReady || !result.isDouyin) {
        return {ok: true, ...result};
      }
      // “作品不存在”页仍会渲染推荐作品、作者和互动控件；这些 DOM 信号
      // 不能反过来证明目标作品已就绪。先处理不可用态，再允许 ready 返回。
      if (result.unavailable) {
        if (result.immediateUnavailable) {
          const error = new Error(
            '抖音提示目标帖子已删除或不存在',
          );
          error.code = 'DOUYIN_CONTENT_UNAVAILABLE';
          error.currentUrl = result.currentUrl || '';
          throw error;
        }
        if (!unavailableSince) unavailableSince = Date.now();
        if (Date.now() - unavailableSince >= DOUYIN_UNAVAILABLE_GRACE_MS) {
          const error = new Error(
            '抖音详情持续显示作品不存在，正在尝试备用入口',
          );
          error.code = 'DOUYIN_CONTENT_UNAVAILABLE';
          error.currentUrl = result.currentUrl || '';
          throw error;
        }
      } else {
        unavailableSince = 0;
        if (result.targetMatched && result.detailReady) {
          return {ok: true, ...result};
        }
      }
      if (result.isSearchModalContext && !result.hasBoundDetailRoot) {
        if (!unboundSearchModalSince) {
          unboundSearchModalSince = Date.now();
        }
        if (
          Date.now() - unboundSearchModalSince >=
          DOUYIN_SEARCH_MODAL_BIND_GRACE_MS
        ) {
          const error = new Error(
            '抖音搜索页未打开目标作品详情，正在尝试直达作品入口',
          );
          error.code = 'DOUYIN_DETAIL_NOT_READY';
          error.currentUrl = result.currentUrl || '';
          error.currentNoteId = result.currentNoteId || '';
          error.conflictingNoteIds = result.conflictingActiveWorkIds || [];
          error.activeWorkIdentityConflict =
            result.activeWorkIdentityConflict === true;
          error.isSearchModalContext =
            result.isSearchModalContext === true;
          throw error;
        }
      } else {
        unboundSearchModalSince = 0;
      }
      if (Date.now() - startedAt >= Math.max(1000, Number(timeoutMs) || 8000)) {
        const error = new Error('抖音详情页未完成加载');
        error.code = 'DOUYIN_DETAIL_NOT_READY';
        error.currentUrl = result.currentUrl || '';
        error.currentNoteId = result.currentNoteId || '';
        error.conflictingNoteIds = result.conflictingActiveWorkIds || [];
        error.activeWorkIdentityConflict =
          result.activeWorkIdentityConflict === true;
        error.isSearchModalContext =
          result.isSearchModalContext === true;
        throw error;
      }
      await waitMs(250);
    }
  } catch (error) {
    if (
      error?.code === 'XHS_SECURITY_BLOCK' ||
      error?.code === 'PAGE_CHALLENGE_BLOCK' ||
      error?.code === 'RATE_LIMITED' ||
      error?.code === 'DOUYIN_CONTENT_UNAVAILABLE' ||
      error?.code === 'DOUYIN_DETAIL_NOT_READY' ||
      String(error?.message || '') === 'DETAIL_CAPTURE_CANCELED'
    ) {
      throw error;
    }
    console.warn(
      '[CaptureSync] detail preload safety probe unavailable:',
      error?.message || error,
    );
    if (waitForDouyinReady) {
      const readinessError = new Error('抖音详情页就绪检查失败');
      readinessError.code = 'DOUYIN_DETAIL_NOT_READY';
      readinessError.cause = error;
      throw readinessError;
    }
    return {ok: true, skipped: true};
  }
}

function isDouyinDirectDetailEntryUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    return Boolean(
      (host === 'douyin.com' || host.endsWith('.douyin.com')) &&
        /^\/(?:video|note)\/\d{8,}(?:\/|$)/i.test(parsed.pathname),
    );
  } catch {
    return false;
  }
}

function buildDouyinTargetRouteNotReadyError(
  result = {},
  message = '抖音目标作品页面尚未稳定',
) {
  const error = new Error(message);
  error.code = 'DOUYIN_DETAIL_NOT_READY';
  error.currentUrl = String(result?.currentUrl || '');
  error.currentNoteId = String(result?.currentNoteId || '');
  error.conflictingNoteIds = Array.isArray(
    result?.conflictingActiveWorkIds,
  )
    ? result.conflictingActiveWorkIds
    : [];
  error.activeWorkIdentityConflict =
    result?.activeWorkIdentityConflict === true;
  error.isSearchModalContext = result?.isSearchModalContext === true;
  return error;
}

async function probeDouyinTargetRouteSafety(
  tabId,
  {
    targetUrl = '',
    verifiedNoteId = '',
    requireVerifiedNoteId = false,
    shouldStop = null,
    timeoutMs = 8000,
  } = {},
) {
  const expectedNoteId = extractNoteId(targetUrl);
  const normalizedVerifiedNoteId = extractDouyinDetailGuardItemId(
    verifiedNoteId,
  );
  if (!expectedNoteId) {
    throw buildDouyinTargetRouteNotReadyError(
      {},
      '抖音目标作品 ID 缺失',
    );
  }
  if (
    requireVerifiedNoteId &&
    normalizedVerifiedNoteId !== expectedNoteId
  ) {
    throw buildDouyinTargetRouteNotReadyError(
      {},
      '抖音正文作品 ID 尚未完成验证',
    );
  }

  const snapshot = await probeDetailPreloadSafety(tabId, {
    targetUrl,
    // 直达作品页的路径本身已绑定作品 ID。这里只读取一次安全态、当前
    // 路径和活动作品冲突，不再重复要求可见 DOM 组合信号。搜索弹层
    // 没有独立路径身份，仍在下方走严格可见校验。
    waitForDouyinReady: false,
    requireVisibleDetailRoot: false,
    shouldStop,
    timeoutMs,
  });
  if (snapshot?.skipped === true) {
    throw buildDouyinTargetRouteNotReadyError(
      snapshot,
      '当前浏览器无法确认抖音目标作品页面',
    );
  }
  if (
    snapshot?.immediateUnavailable === true ||
    (requireVerifiedNoteId && snapshot?.unavailable === true)
  ) {
    const error = new Error('抖音提示目标帖子已删除或不存在');
    error.code = 'DOUYIN_CONTENT_UNAVAILABLE';
    error.currentUrl = String(snapshot?.currentUrl || '');
    throw error;
  }

  const currentUrl = String(snapshot?.currentUrl || '');
  const currentNoteId = extractDouyinDetailGuardItemId(
    snapshot?.currentNoteId,
  );
  if (isDouyinDirectDetailEntryUrl(currentUrl)) {
    const directRouteNoteId = extractNoteId(currentUrl);
    if (
      directRouteNoteId !== expectedNoteId ||
      (currentNoteId && currentNoteId !== expectedNoteId) ||
      snapshot?.targetMatched !== true
    ) {
      throw buildDouyinTargetRouteNotReadyError(
        snapshot,
        '抖音直达页作品 ID 与目标不一致',
      );
    }
    // URL 与正文 ID 一致仍不能覆盖真实活动作品冲突。这里仅移除可见
    // DOM 水合门槛；若页面明确显示另一个活动作品，所有阶段继续 fail closed。
    if (snapshot?.activeWorkIdentityConflict === true) {
      throw buildDouyinTargetRouteNotReadyError(
        snapshot,
        '抖音直达页作品身份尚未稳定',
      );
    }
    return {
      ...snapshot,
      currentNoteId: expectedNoteId,
      routeKind: 'direct',
      directRouteAccepted: true,
      hydrationDeferred: snapshot?.detailReady !== true,
    };
  }

  if (
    snapshot?.isSearchModalContext === true &&
    currentNoteId === expectedNoteId
  ) {
    const ready = await probeDetailPreloadSafety(tabId, {
      targetUrl,
      waitForDouyinReady: true,
      requireVisibleDetailRoot: true,
      shouldStop,
      timeoutMs,
    });
    const readyNoteId = extractDouyinDetailGuardItemId(
      ready?.currentNoteId,
    );
    if (readyNoteId !== expectedNoteId) {
      throw buildDouyinTargetRouteNotReadyError(
        ready,
        '抖音搜索弹层作品 ID 与目标不一致',
      );
    }
    return {
      ...ready,
      currentNoteId: expectedNoteId,
      routeKind: 'search_modal',
      directRouteAccepted: false,
      hydrationDeferred: false,
    };
  }

  throw buildDouyinTargetRouteNotReadyError(snapshot);
}

async function probeDouyinNavigationEntry(
  tabId,
  {
    targetUrl = '',
    shouldStop = null,
    timeoutMs = 8000,
  } = {},
) {
  return await probeDouyinTargetRouteSafety(tabId, {
    targetUrl,
    shouldStop,
    timeoutMs,
  });
}

async function ensureDouyinCommentTargetReadyInTab({
  tabId,
  record,
  targetUrl,
  verifiedNoteId = '',
  sourcePageUrl = '',
  shouldStop = null,
  navigateCandidate = null,
  onRecovery = null,
} = {}) {
  try {
    const current = await probeDouyinTargetRouteSafety(tabId, {
      targetUrl,
      verifiedNoteId,
      requireVerifiedNoteId: true,
      shouldStop,
      timeoutMs: DOUYIN_COMMENT_READY_PROBE_TIMEOUT_MS,
    });
    return {ok: true, recovered: false, url: current?.currentUrl || targetUrl};
  } catch (error) {
    if (
      isDetailSecurityBlockError(error) ||
      String(error?.message || '') === 'DETAIL_CAPTURE_CANCELED'
    ) {
      throw error;
    }
    if (typeof onRecovery === 'function') {
      await onRecovery(error);
    }
  }

  const candidates = buildDouyinCommentRecoveryCandidates(
    record,
    targetUrl,
    sourcePageUrl,
  );
  let lastError = null;
  for (const candidateUrl of candidates) {
    try {
      const operation = async () => {
        await openUrlInTab(tabId, candidateUrl, {
          timeoutMs: DOUYIN_DETAIL_NAV_CANDIDATE_TIMEOUT_MS,
          shouldStop,
          active: true,
        });
        return await probeDouyinTargetRouteSafety(tabId, {
          targetUrl: candidateUrl,
          verifiedNoteId,
          requireVerifiedNoteId: true,
          shouldStop,
          timeoutMs: DOUYIN_COMMENT_RECOVERY_READY_TIMEOUT_MS,
        });
      };
      const ready =
        typeof navigateCandidate === 'function'
          ? await navigateCandidate(operation, candidateUrl)
          : await operation();
      return {
        ok: true,
        recovered: true,
        url: ready?.currentUrl || candidateUrl,
      };
    } catch (error) {
      if (
        isDetailSecurityBlockError(error) ||
        String(error?.message || '') === 'DETAIL_CAPTURE_CANCELED'
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  const error = new Error(
    lastError?.message || '无人值守未能重新定位到目标抖音作品详情页',
  );
  error.code = String(lastError?.code || 'DOUYIN_COMMENT_TARGET_NOT_READY');
  error.cause = lastError || null;
  throw error;
}

function isDetailSecurityBlockError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  return (
    code === 'XHS_SECURITY_BLOCK' ||
    code === DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE ||
    code === 'SECURITY_VERIFICATION_REQUIRED' ||
    code === 'PLATFORM_SAFETY_BLOCK' ||
    code === 'PAGE_CHALLENGE_BLOCK' ||
    code === 'HTTP_429' ||
    code === 'RATE_LIMITED' ||
    error?.securityBlocked === true ||
    error?.platformSafetyBlocked === true ||
    error?.securityEvidence?.confirmed === true
  );
}

async function findNextDetailPrefetchCandidate({
  recordIds,
  startIndex,
  skipRecordIdSet,
} = {}) {
  const candidates = Array.isArray(recordIds) ? recordIds : [];
  for (let index = Math.max(0, Number(startIndex) || 0); index < candidates.length; index += 1) {
    const recordId = candidates[index];
    if (skipRecordIdSet?.has(recordId)) continue;
    const record = await getRecord(recordId);
    if (!record || !isDetailCaptureRecordType(record.type)) continue;
    const url = resolveRecordNoteUrl(record);
    if (!url) continue;
    return {recordId, url, index};
  }
  return null;
}

function isTargetNoteOpened(currentUrl, targetUrl, targetNoteId = '') {
  const normalizedCurrent = String(currentUrl || '').trim();
  const normalizedTarget = String(targetUrl || '').trim();
  if (!normalizedCurrent) return false;
  if (!normalizedTarget) return false;

  if (targetNoteId) {
    const currentNoteId = extractNoteId(normalizedCurrent);
    if (currentNoteId && currentNoteId === targetNoteId) {
      return true;
    }
  }

  if (isSameSearchOrDiscoveryRoute(normalizedCurrent, normalizedTarget)) {
    return true;
  }

  if (isSameOriginAndPathname(normalizedCurrent, normalizedTarget)) {
    return true;
  }

  return normalizeUrlWithoutHash(normalizedCurrent) === normalizeUrlWithoutHash(normalizedTarget);
}

function normalizeUrlWithoutHash(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return '';

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return normalized.split('#')[0];
  }
}

function isSameSearchOrDiscoveryRoute(urlA, urlB) {
  try {
    const parsedA = new URL(String(urlA || '').trim());
    const parsedB = new URL(String(urlB || '').trim());
    if (parsedA.origin !== parsedB.origin) {
      return false;
    }

    return (
      isSearchOrDiscoveryPath(parsedA.pathname) &&
      isSearchOrDiscoveryPath(parsedB.pathname)
    );
  } catch {
    return false;
  }
}

function isSearchOrDiscoveryPath(pathname) {
  const normalized = String(pathname || '').toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes('/search_result') ||
    normalized.includes('/web/search_result') ||
    normalized.includes('/search/result') ||
    /^\/(?:explore|discovery)\/?$/.test(normalized)
  );
}

function isSameOriginAndPathname(urlA, urlB) {
  try {
    const parsedA = new URL(String(urlA || '').trim());
    const parsedB = new URL(String(urlB || '').trim());

    const pathnameA = parsedA.pathname.replace(/\/+$/, '') || '/';
    const pathnameB = parsedB.pathname.replace(/\/+$/, '') || '/';

    return parsedA.origin === parsedB.origin && pathnameA === pathnameB;
  } catch {
    return false;
  }
}

function isDetailCaptureCanceledError(error) {
  const message = String(error?.message || '');
  return message === 'DETAIL_CAPTURE_CANCELED';
}

function isBatchCaptureCanceledError(error) {
  const message = String(error?.message || '');
  return (
    message === 'BATCH_CAPTURE_CANCELED' ||
    message === 'DETAIL_CAPTURE_CANCELED'
  );
}

function isCaptureCanceledResult(result) {
  const errorCode = String(result?.error?.code || '').trim().toUpperCase();
  const errorMessage = String(result?.error?.message || '').trim();
  return (
    errorCode === 'CAPTURE_CANCELED' ||
    errorCode === 'BATCH_CAPTURE_CANCELED' ||
    errorMessage === 'BATCH_CAPTURE_CANCELED' ||
    errorMessage === 'DETAIL_CAPTURE_CANCELED'
  );
}

// ── 可靠时钟:后台标签页免疫 Chrome 计时器节流 ─────────────────────────────
// Chrome 对隐藏超约 5 分钟的标签页做强力节流:页面 setTimeout 被对齐到约 1 分钟
// 一次。无人值守的编排代码跑在隐藏 runner 标签页里,全靠 setTimeout 等待/轮询,
// 被节流后整个流程以分钟级爬行(「第一个词正常、第二个词起假死」的根因)。
// Worker 线程的计时器不受页面可见性节流,用它做时钟;创建失败自动回退 setTimeout。
let reliableTimerWorker = null;
let reliableTimerSeq = 0;
const reliableTimerPending = new Map();

function getReliableTimerWorker() {
  if (reliableTimerWorker !== null) {
    return reliableTimerWorker;
  }
  try {
    reliableTimerWorker = new Worker(
      chrome.runtime.getURL('utils/timer-worker.js'),
    );
    reliableTimerWorker.onmessage = (event) => {
      const id = event?.data?.id;
      const pending = reliableTimerPending.get(id);
      if (pending) {
        reliableTimerPending.delete(id);
        if (pending.fallbackTimer) {
          clearTimeout(pending.fallbackTimer);
        }
        pending.resolve();
      }
    };
    reliableTimerWorker.onerror = () => {
      // Worker 挂了:把悬着的等待用 setTimeout 兜底放行,并永久回退旧方式
      const pending = [...reliableTimerPending.values()];
      reliableTimerPending.clear();
      try {
        reliableTimerWorker.terminate();
      } catch {
        // ignore
      }
      reliableTimerWorker = false;
      pending.forEach((item) => {
        if (item.fallbackTimer) {
          clearTimeout(item.fallbackTimer);
        }
        setTimeout(item.resolve, 50);
      });
    };
  } catch {
    reliableTimerWorker = false;
  }
  return reliableTimerWorker;
}

function waitMs(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  const worker = getReliableTimerWorker();
  if (!worker) {
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
  return new Promise((resolve) => {
    reliableTimerSeq += 1;
    const id = reliableTimerSeq;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      reliableTimerPending.delete(id);
      resolve();
    };
    // Worker 若静默丢失且没有触发 onerror，墙钟兜底仍会在页面恢复后放行。
    const fallbackTimer = setTimeout(finish, delay + 2000);
    reliableTimerPending.set(id, {resolve: finish, fallbackTimer});
    try {
      worker.postMessage({ id, ms: delay });
    } catch {
      reliableTimerPending.delete(id);
      clearTimeout(fallbackTimer);
      setTimeout(finish, delay);
    }
  });
}

async function waitMsWithStop(ms, shouldStop, errorMessage = 'BATCH_CAPTURE_CANCELED') {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 0) {
    return;
  }

  const step = 100;
  let elapsed = 0;
  while (elapsed < total) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error(errorMessage);
    }
    const remaining = Math.min(step, total - elapsed);
    await waitMs(remaining);
    elapsed += remaining;
  }
}

async function waitMsWithStopAndTick(
  ms,
  shouldStop,
  {
    errorMessage = 'BATCH_CAPTURE_CANCELED',
    tickMs = 1000,
    onTick = null,
  } = {},
) {
  const total = Math.max(0, Number(ms) || 0);
  if (total <= 0) {
    return;
  }

  const startedAt = Date.now();
  let lastRemainingSeconds = -1;
  while (Date.now() - startedAt < total) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error(errorMessage);
    }
    const remainingMs = Math.max(0, total - (Date.now() - startedAt));
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    if (
      typeof onTick === 'function' &&
      remainingSeconds !== lastRemainingSeconds
    ) {
      lastRemainingSeconds = remainingSeconds;
      await Promise.resolve(onTick(remainingMs));
    }
    await waitMs(Math.min(Math.max(100, Number(tickMs) || 1000), remainingMs));
  }
}

async function activateTabForReliableTimer(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId) || numericTabId <= 0) {
    return false;
  }
  try {
    const tab = await chrome.tabs.get(numericTabId);
    if (Number.isFinite(Number(tab?.windowId)) && Number(tab.windowId) >= 0) {
      await chrome.windows.update(Number(tab.windowId), { focused: true });
    }
    await chrome.tabs.update(numericTabId, { active: true });
    return true;
  } catch {
    return false;
  }
}

async function captureCommentsForCurrentNote({
  tabId,
  captureRequestId = '',
  recordId = '',
  current = 0,
  total = 0,
  existingItems = [],
  maxDetectedItems,
  maxDurationMs,
  waitMinMs,
  waitMaxMs,
  stallTimeoutMs,
  expectedNoteId = '',
  verifiedNoteId = '',
}) {
  const savedItems = Array.isArray(existingItems) ? existingItems : [];
  const commentCaptureIdentity = await ensureCommentCaptureIdentity({
    captureRequestId,
    runnerTabId: tabId,
  });
  let result = null;
  try {
    result = await captureInTab(commentCaptureIdentity.runnerTabId, {
      mode: 'comments',
      captureParams: {
        captureRequestId: commentCaptureIdentity.captureRequestId,
        recordId,
        current,
        total,
        onlyLevel1: false,
        maxDetectedItems,
        maxDurationMs,
        waitMinMs,
        waitMaxMs,
        stallTimeoutMs,
        expectedNoteId,
        verifiedNoteId,
      },
    });
  } catch (error) {
    if (
      isDetailSecurityBlockError(error) ||
      isDouyinIdentityIntegrityError(error)
    ) {
      throw error;
    }
    return {
      status: COMMENT_CAPTURE_STATUS.FAILED,
      stoppedByUser: false,
      stoppedByStall: false,
      stoppedByNetwork: false,
      stopReason: '',
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      noteId: '',
      cleanedItems: savedItems,
      mergedText: buildCommentsMergedText(savedItems),
      errorCode: String(error?.code || 'CAPTURE_FAILED'),
      error: error?.message || '评论采集失败',
    };
  }

  if (!result?.ok) {
    if (
      isDetailSecurityBlockError(result?.error) ||
      isDouyinIdentityIntegrityError(result?.error)
    ) {
      const error = new Error(
        result?.error?.message ||
          (isDouyinIdentityIntegrityError(result?.error)
            ? '评论采集目标身份不一致，已停止详情批次'
            : '评论采集遇到安全验证，已停止详情批次'),
      );
      error.code =
        String(result?.error?.code || '').trim().toUpperCase() ||
        (isDouyinIdentityIntegrityError(result?.error)
          ? 'DOUYIN_COMMENT_ID_MISMATCH'
          : 'PAGE_CHALLENGE_BLOCK');
      throw error;
    }
    return {
      status: COMMENT_CAPTURE_STATUS.FAILED,
      stoppedByUser: false,
      stoppedByStall: false,
      stoppedByNetwork: false,
      stopReason: '',
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      noteId: resolveCapturedDouyinCommentNoteId(result),
      cleanedItems: savedItems,
      mergedText: buildCommentsMergedText(savedItems),
      errorCode: String(result?.error?.code || 'CAPTURE_FAILED'),
      error: result?.error?.message || '评论采集失败',
    };
  }

  const capturedNoteId = resolveCapturedDouyinCommentNoteId(result);
  const commentIdentityFailure = buildDouyinCommentIdentityFailure(
    expectedNoteId,
    capturedNoteId,
  );
  if (commentIdentityFailure) {
    return {
      status: COMMENT_CAPTURE_STATUS.FAILED,
      stoppedByUser: false,
      stoppedByStall: false,
      stoppedByNetwork: false,
      stopReason: '',
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      noteId: capturedNoteId,
      cleanedItems: savedItems,
      mergedText: buildCommentsMergedText(savedItems),
      errorCode: commentIdentityFailure.code,
      error: commentIdentityFailure.message,
    };
  }

  const rawItems = Array.isArray(result.data?.items) ? result.data.items : [];
  const effectiveMaxDetectedItems = resolveCommentMergeLimit(
    maxDetectedItems,
    savedItems.length,
  );
  const cleanedItems = cleanCommentsItems([
    ...savedItems,
    ...rawItems,
  ]).slice(0, effectiveMaxDetectedItems);
  const captureStatus = String(
    result.data?.captureStatus || result.meta?.captureStatus || '',
  )
    .trim()
    .toLowerCase();
  const partial = captureStatus === COMMENT_CAPTURE_STATUS.PARTIAL;
  const stoppedByUser = Boolean(
    result.data?.stoppedByUser || result.meta?.stoppedByUser,
  );
  const stoppedByStall = Boolean(
    result.data?.stoppedByStall || result.meta?.stoppedByStall,
  );
  const stopReason = String(
    result.data?.stopReason || result.meta?.scrollInfo?.stopReason || '',
  );
  const stoppedByNetwork = stopReason === 'network_timeout';
  const partialMessage = partial
    ? commentCapturePartialMessage({
        stopReason,
        stoppedByUser,
        stoppedByStall,
        stoppedByNetwork,
        collectedCount: cleanedItems.length,
      })
    : '';

  return {
    status: partial ? COMMENT_CAPTURE_STATUS.PARTIAL : COMMENT_CAPTURE_STATUS.DONE,
    stoppedByUser,
    stoppedByStall,
    stoppedByNetwork,
    stopReason,
    captureRequestId: commentCaptureIdentity.captureRequestId,
    runnerTabId: commentCaptureIdentity.runnerTabId,
    noteId: capturedNoteId,
    cleanedItems,
    mergedText: buildCommentsMergedText(cleanedItems),
    errorCode: '',
    error: partialMessage,
  };
}

async function captureCommentsForHydratedDetailRecord(
  recordId,
  {
    tabId,
    captureRequestId = '',
    verifiedNoteId: providedVerifiedNoteId = '',
    settings = {},
    commentsMaxDetectedItems = null,
    onProgress = null,
  } = {},
) {
  const record = await getRecord(recordId);
  const detailPayload = record?.payload?.detailPayload;
  if (
    !record ||
    !isDetailCaptureRecordType(record.type) ||
    !detailPayload ||
    typeof detailPayload !== 'object'
  ) {
    return {
      ok: false,
      phase: 'invalid_record',
      recordId,
      error: {
        code: 'RECORD_NOT_HYDRATED',
        message: '记录缺少详情数据，无法仅继续评论采集',
      },
    };
  }

  const commentCaptureIdentity = await ensureCommentCaptureIdentity({
    captureRequestId,
    runnerTabId: tabId,
    resolveRunnerTab: () => resolveCaptureTargetTab({mode: 'comments'}),
  });
  const maxDetectedItems = normalizeCommentsMaxDetectedItems(
    settings.detailCommentsMaxDetectedItems ?? commentsMaxDetectedItems,
    settings.commentsMaxDetectedItems,
  );
  const expectedNoteId = resolveExpectedDouyinCommentNoteId(
    record,
    resolveRecordNoteUrl(record),
  );
  const startedAt = Date.now();
  const latestBeforeStart = (await getRecord(recordId)) || record;
  const latestDetailPayload =
    latestBeforeStart.payload?.detailPayload &&
    typeof latestBeforeStart.payload.detailPayload === 'object'
      ? latestBeforeStart.payload.detailPayload
      : detailPayload;
  // Do not use latestDetailPayload as current-page proof. It may have been
  // captured hours earlier or imported from another run.
  const verifiedNoteId =
    extractDouyinDetailGuardItemId(providedVerifiedNoteId) === expectedNoteId
      ? expectedNoteId
      : '';
  const capturingDetailPayload = applyCommentStatusToPayload(
    clearInterruptedCommentObservation(latestDetailPayload),
    createCommentStatusPatch({
      status: COMMENT_CAPTURE_STATUS.CAPTURING,
      startedAt,
      finishedAt: 0,
      stoppedByUser: false,
      error: '',
    }),
  );
  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: {
      ...latestBeforeStart.payload,
      detailPayload: capturingDetailPayload,
    },
  });
  if (onProgress) {
    onProgress({
      phase: 'comments_capturing',
      message: `正在继续评论采集（已有 ${Number(capturingDetailPayload.commentsTotalCaptured) || 0} 条）`,
      recordId,
      collectedCount: Number(capturingDetailPayload.commentsTotalCaptured) || 0,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      captureAction: 'captureComments',
    });
  }

  let result;
  try {
    result = await captureCommentsForCurrentNote({
      tabId: commentCaptureIdentity.runnerTabId,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      recordId,
      current: 1,
      total: 1,
      existingItems: capturingDetailPayload.commentsCleanedItems,
      maxDetectedItems,
      maxDurationMs: settings.sharedMaxDurationMs,
      waitMinMs: settings.sharedWaitMinMs,
      waitMaxMs: settings.sharedWaitMaxMs,
      stallTimeoutMs: settings.sharedStallTimeoutMs,
      expectedNoteId,
      verifiedNoteId,
    });
  } catch (error) {
    const latestAfterFailure = (await getRecord(recordId)) || latestBeforeStart;
    const failedDetailPayload = applyCommentStatusToPayload(
      capturingDetailPayload,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.FAILED,
        startedAt,
        finishedAt: Date.now(),
        stoppedByUser: false,
        error: error?.message || '评论采集失败，请稍后重试',
        cleanedItems: capturingDetailPayload.commentsCleanedItems,
        mergedText: buildCommentsMergedText(
          capturingDetailPayload.commentsCleanedItems,
        ),
      }),
    );
    const failure = classifyDetailCaptureFailure(error, {
      stage: 'comments_capture',
    });
    const failedRecordPayload = applyDetailCapturePatch(
      latestAfterFailure.payload,
      createDetailCapturePatch({
        status: DETAIL_CAPTURE_STATUS.FAILED,
        startedAt:
          Number(latestAfterFailure.payload?.detailCaptureStartedAt) ||
          startedAt,
        finishedAt: Date.now(),
        error: failure.userMessage,
        failureCode: failure.code,
        failureStage: failure.stage,
        failureCategory: failure.category,
        diagnosticMessage: failure.diagnosticMessage,
        noteUrl:
          latestAfterFailure.payload?.detailCaptureNoteUrl ||
          resolveRecordNoteUrl(latestAfterFailure),
        detailPayload: failedDetailPayload,
      }),
    );
    await updateRecord(recordId, {
      status: RECORD_STATUS.DRAFT,
      payload: failedRecordPayload,
    });
    throw error;
  }
  const commentIdentityFailure =
    result.status !== COMMENT_CAPTURE_STATUS.FAILED ||
    result.errorCode === 'DOUYIN_COMMENT_ID_MISMATCH'
      ? buildDouyinCommentIdentityFailure(
          expectedNoteId,
          resolveCapturedDouyinCommentNoteId(result),
        )
      : null;
  const mergeResult = commentIdentityFailure
    ? {
        ...result,
        status: COMMENT_CAPTURE_STATUS.FAILED,
        errorCode: commentIdentityFailure.code,
        error: commentIdentityFailure.message,
        cleanedItems: Array.isArray(capturingDetailPayload.commentsCleanedItems)
          ? capturingDetailPayload.commentsCleanedItems
          : [],
      }
    : result;
  let nextDetailPayload = applyCommentResultToSingleNotePayload(
    capturingDetailPayload,
    mergeResult,
  );
  const commentLeadsConfig = buildCommentLeadsConfigFromSettings({
    ...settings,
    enableCommentLeadsFilter:
      settings.enableCommentLeadsFilterOnDetailCapture ??
      settings.enableCommentLeadsFilter,
  });
  nextDetailPayload = applyCommentLeadsToPayload({
    syncType: SYNC_TYPE.SINGLE_NOTE,
    payload: nextDetailPayload,
    commentLeadsConfig,
    computedAt: Date.now(),
  }).payload;

  const failed = mergeResult.status === COMMENT_CAPTURE_STATUS.FAILED;
  const partial = mergeResult.status === COMMENT_CAPTURE_STATUS.PARTIAL;
  const latestRecord = (await getRecord(recordId)) || record;
  const commentFailure = failed || partial
    ? commentIdentityFailure
      ? classifyDetailCaptureFailure(
          Object.assign(new Error(commentIdentityFailure.message), {
            code: commentIdentityFailure.code,
          }),
          {stage: 'comments_capture'},
        )
      : buildDetailCaptureFailure(
          DETAIL_CAPTURE_FAILURE_CODE.COMMENTS_CAPTURE_FAILED,
          'comments_capture',
          mergeResult.error ||
            (partial
              ? '评论采集尚未完成，已保留当前结果'
              : '评论采集失败'),
        )
    : null;
  const nextRecordPayload = applyDetailCapturePatch(
    latestRecord.payload,
    createDetailCapturePatch({
      status:
        failed || partial
          ? DETAIL_CAPTURE_STATUS.FAILED
          : DETAIL_CAPTURE_STATUS.DONE,
      startedAt:
        Number(latestRecord.payload?.detailCaptureStartedAt) || startedAt,
      finishedAt: Date.now(),
      error: commentFailure?.userMessage || '',
      failureCode: commentFailure?.code || '',
      failureStage: commentFailure?.stage || '',
      failureCategory: commentFailure?.category || '',
      diagnosticMessage: commentFailure?.diagnosticMessage || '',
      noteUrl:
        latestRecord.payload?.detailCaptureNoteUrl ||
        resolveRecordNoteUrl(latestRecord),
      detailPayload: nextDetailPayload,
    }),
  );
  await updateRecord(recordId, {
    status: RECORD_STATUS.DRAFT,
    payload: nextRecordPayload,
  });

  const phase = failed
    ? 'comments_failed'
    : partial
      ? 'comments_partial'
      : 'comments_done';
  if (onProgress) {
    onProgress({
      phase,
      message: failed
        ? '评论采集失败，可在记录卡片继续'
        : partial
          ? commentCapturePartialMessage({
              stopReason: mergeResult.stopReason,
              stoppedByUser: mergeResult.stoppedByUser,
              stoppedByStall: mergeResult.stoppedByStall,
              stoppedByNetwork: mergeResult.stoppedByNetwork,
              collectedCount: mergeResult.cleanedItems.length,
            })
          : `评论已合并（${mergeResult.cleanedItems.length}条）`,
      recordId,
      collectedCount: mergeResult.cleanedItems.length,
      captureRequestId: commentCaptureIdentity.captureRequestId,
      runnerTabId: commentCaptureIdentity.runnerTabId,
      captureAction: 'captureComments',
      stoppedByUser: Boolean(mergeResult.stoppedByUser),
      stoppedByStall: Boolean(mergeResult.stoppedByStall),
      stoppedByNetwork: Boolean(mergeResult.stoppedByNetwork),
      stopReason: String(mergeResult.stopReason || ''),
      error: failed
        ? {
            code: mergeResult.errorCode || 'CAPTURE_FAILED',
            message: mergeResult.error || '评论采集失败',
          }
        : null,
    });
  }

  return {
    ok: !failed,
    phase,
    recordId,
    captureRequestId: commentCaptureIdentity.captureRequestId,
    runnerTabId: commentCaptureIdentity.runnerTabId,
    commentsCount: mergeResult.cleanedItems.length,
    partial,
    stoppedByUser: Boolean(mergeResult.stoppedByUser),
    stoppedByStall: Boolean(mergeResult.stoppedByStall),
    stoppedByNetwork: Boolean(mergeResult.stoppedByNetwork),
    stopReason: String(mergeResult.stopReason || ''),
    error: failed
      ? {
          code: mergeResult.errorCode || 'CAPTURE_FAILED',
          message: mergeResult.error || '评论采集失败',
        }
      : null,
  };
}

export function applyCommentResultToSingleNotePayload(payload, result) {
  const now = Date.now();
  const payloadWithoutPreviousObservation =
    clearInterruptedCommentObservation(payload);

  if (result.status === COMMENT_CAPTURE_STATUS.FAILED) {
    return applyCommentStatusToPayload(
      payloadWithoutPreviousObservation,
      createCommentStatusPatch({
        status: COMMENT_CAPTURE_STATUS.FAILED,
        startedAt: now,
        finishedAt: now,
        stoppedByUser: false,
        error: result.error || '评论采集失败',
        cleanedItems: Array.isArray(result.cleanedItems)
          ? result.cleanedItems
          : null,
        mergedText:
          typeof result.mergedText === 'string' ? result.mergedText : null,
      }),
    );
  }

  return applyCommentStatusToPayload(
    payloadWithoutPreviousObservation,
    createCommentStatusPatch({
      status: result.status,
      startedAt: now,
      finishedAt: now,
      stoppedByUser: Boolean(result.stoppedByUser),
      error: result.stoppedByStall ? result.error || '评论采集中断' : '',
      cleanedItems: Array.isArray(result.cleanedItems) ? result.cleanedItems : [],
      mergedText: String(result.mergedText || ''),
    }),
  );
}

export function applyCommentLeadsToPayload({
  syncType,
  payload,
  commentLeadsConfig,
  computedAt = Date.now(),
}) {
  const normalizedPayload = applyCommentStatusToPayload(payload, {});
  const normalizedConfig = normalizeCommentLeadsConfig(commentLeadsConfig);
  const leadResult = buildCommentLeadsPayloadForRecord(
    {
      type: syncType,
      payload: normalizedPayload,
    },
    normalizedConfig,
  );

  const nextPayload = applyCommentStatusToPayload(
    normalizedPayload,
    createCommentStatusPatch({
      status:
        normalizedPayload.commentsCaptureStatus || COMMENT_CAPTURE_STATUS.NOT_STARTED,
      startedAt: normalizedPayload.commentsCaptureStartedAt || 0,
      finishedAt: normalizedPayload.commentsCaptureFinishedAt || 0,
      stoppedByUser: Boolean(normalizedPayload.commentsCaptureStoppedByUser),
      error: normalizedPayload.commentsCaptureError || '',
      cleanedItems: normalizedPayload.commentsCleanedItems || [],
      mergedText: normalizedPayload.commentsMergedText || '',
      commentLeadsEnabled: normalizedConfig.enabled,
      commentLeadsKeywords: normalizedConfig.keywords,
      commentLeadsIps: normalizedConfig.ips,
      commentLeadsItems: leadResult.payload?.items || [],
      commentLeadsTotal: leadResult.matchedCount,
      commentLeadsLastComputedAt: computedAt,
    }),
  );

  return {
    payload: nextPayload,
    leadResult,
  };
}

async function getTabScrollY(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return Number(window.scrollY || 0);
      },
    });
    const value = Number(result?.result);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function restoreSourcePageIfNeeded(
  tabId,
  sourcePageUrl,
  sourcePageScrollY = 0,
  { timeoutMs = DETAIL_CAPTURE_NAV_TIMEOUT_MS } = {},
) {
  const normalizedSource = normalizeOpenUrl(sourcePageUrl);
  if (!normalizedSource) {
    return;
  }

  let currentUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = String(tab?.url || '');
  } catch {
    return;
  }

  if (!isTargetNoteOpened(currentUrl, normalizedSource, extractNoteId(normalizedSource))) {
    try {
      await openUrlInTab(tabId, normalizedSource, { timeoutMs, active: true });
    } catch (error) {
      console.warn('[CaptureSync] restore source page failed:', error);
      return;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scrollY) => {
        window.scrollTo({
          top: Number(scrollY) || 0,
          left: 0,
          behavior: 'auto',
        });
      },
      args: [Math.max(0, Number(sourcePageScrollY) || 0)],
    });
  } catch (error) {
    console.warn('[CaptureSync] restore source scroll failed:', error);
  }
}

async function restoreSourceRuntimeContextIfNeeded({
  tabId,
  sourcePageUrl,
  sourcePlatform = 'unknown',
  sourcePageType = PAGE_TYPE.UNKNOWN,
} = {}) {
  const normalizedSource = normalizeOpenUrl(sourcePageUrl);
  if (!normalizedSource) {
    return;
  }

  await updateRuntime({
    lastActiveTabId: Number.isFinite(Number(tabId)) ? Number(tabId) : null,
    lastPageUrl: normalizedSource,
    platform: sourcePlatform || detectPlatformFromUrl(normalizedSource),
    pageType: sourcePageType || detectPageType(normalizedSource),
  });
}

function buildRecordsForStorage(captureResult) {
  const type = captureResult?.type || '';
  const payload =
    captureResult?.data && typeof captureResult.data === 'object'
      ? captureResult.data
      : null;
  const meta =
    captureResult?.meta && typeof captureResult.meta === 'object'
      ? captureResult.meta
      : {};
  const platform = captureResult?.platform || '';

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  // 将博主笔记/搜索笔记按“单条笔记”拆分缓存，便于页面逐条展示和操作
  if ((type === 'blogger_notes' || type === 'keyword_notes') && Array.isArray(payload.items)) {
    if (payload.items.length === 0) return [];

    return payload.items.map((item) => {
      const normalizedItem = normalizeDetailRecordItem(item, payload);
      const nextPayload = ensureDetailCaptureFields({
        ...payload,
        totalCount: 1,
        items: [normalizedItem],
      });
      const preview = buildRecordPreview(type, nextPayload);
      const record = {
        ...createRecordEnvelope({
          platform,
          type,
          data: nextPayload,
          meta,
        }),
        title: preview.title,
        summary: preview.summary,
      };
      const boundTrace = bindCaptureTrace(
        normalizedItem.captureTrace,
        record.id,
        'saved',
      );
      return boundTrace
        ? applyCaptureTraceToRecord(record, boundTrace)
        : record;
    });
  }

  const preview = buildRecordPreview(type, payload);
  const record = {
    ...createRecordEnvelope({
      platform,
      type,
      data: payload,
      meta,
    }),
    title: preview.title,
    summary: preview.summary,
  };
  const boundTrace = bindCaptureTrace(
    resolveCaptureTraceFromPayload(payload),
    record.id,
    'saved',
  );
  return [boundTrace ? applyCaptureTraceToRecord(record, boundTrace) : record];
}

function buildRecordPreview(type, payload) {
  if (!payload || typeof payload !== 'object') {
    return { title: '无标题数据', summary: '无内容摘要...' };
  }

  if (type === 'single_note') {
    return {
      title: payload.title || payload.noteId || '单篇笔记',
      summary: payload.content || payload.url || '单篇笔记采集数据',
    };
  }

  if (type === 'blogger_profile') {
    return {
      title: payload.bloggerName || payload.bloggerId || '博主信息',
      summary: payload.description || payload.bloggerUrl || '博主主页信息采集数据',
    };
  }

  if (type === 'blogger_notes') {
    const firstItem = (payload.items || [])[0] || {};
    return {
      title: firstItem.title || '博主笔记',
      summary: `${firstItem.author || payload.bloggerName || '作者未知'} · 点赞 ${firstItem.likes || 0}`,
    };
  }

  if (type === 'keyword_notes') {
    const firstItem = (payload.items || [])[0] || {};
    const sortDimension = String(payload.sortDimension || '').trim().toLowerCase();
    const metricLabel =
      sortDimension === 'collects'
        ? '收藏'
        : sortDimension === 'comments'
          ? '评论'
          : '点赞';
    const metricValue =
      sortDimension === 'collects'
        ? firstItem.collects || 0
        : sortDimension === 'comments'
          ? firstItem.comments || 0
          : firstItem.likes || 0;
    return {
      title: firstItem.title || (payload.keyword ? `关键词：${payload.keyword}` : '搜索结果笔记'),
      summary: `${firstItem.author || '作者未知'} · ${metricLabel} ${metricValue}`,
    };
  }

  if (type === 'comments') {
    return {
      title: payload.noteTitle || payload.noteId || '评论采集',
      summary: `共 ${payload.totalCount || 0} 条评论`,
    };
  }

  return { title: '无标题数据', summary: '无内容摘要...' };
}

function isDouyinContentFlowUrl(url = '') {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return false;
  }

  if (!/douyin\.com/i.test(normalized)) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const pathname = String(parsed.pathname || '').toLowerCase();

    if (parsed.searchParams.get('modal_id')) {
      return true;
    }

    if (pathname.startsWith('/search/') || pathname.startsWith('/jingxuan/search')) {
      return true;
    }
  } catch {
    return /[?&]modal_id=/i.test(normalized);
  }

  return false;
}

// ==================== 关键词裂变批量采集 ====================

const BATCH_KEYWORD_DELAY_MIN_MS = 3000;
const BATCH_KEYWORD_DELAY_MAX_MS = 5000;
// 不同搜索词之间的随机间隔:保持随机化,但不要把多关键词任务拖得过长。
const BATCH_INTER_KEYWORD_DELAY_MIN_MS = 30 * 1000;
const BATCH_INTER_KEYWORD_DELAY_MAX_MS = 90 * 1000;
const BATCH_KEYWORD_NAV_TIMEOUT_MS = 15000;
const BATCH_KEYWORD_NAV_POLL_MS = 300;
const BATCH_KEYWORD_AFTER_NAV_WAIT_MS = 2000;
const BATCH_KEYWORD_RESULTS_READY_TIMEOUT_MS = 12000;
const DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS = 45000;
// 抖音慢网/高负载下，结果卡可能已出现，但提交 witness 的 busy/clear/root
// lifecycle 仍晚于固定 45 秒。只在当前提交仍有可见结果或近期签名进展时，
// 允许一次有界探测；它不会放宽结果代际或筛选确认门，也不会重新提交搜索。
const DOUYIN_KEYWORD_RESULTS_SLOW_PROGRESS_EXTENSION_MS = 30000;
const DOUYIN_KEYWORD_RESULTS_PROGRESS_RECENCY_MS = 15000;
const BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS = 5000;
const BATCH_KEYWORD_RESULTS_STABLE_POLLS = 2;
const DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS = 2;
const DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS = 1500;
// 0.3.32 在搜索后固定等待 2 秒、筛选后等待 1.2 秒。后来为尽快识别异常页移除了
// 抖音等待，导致搜索→筛选→读取动作过密。恢复基础停顿并加入轻微随机化，同时轮询
// 安全验证；这只降低触发概率，不会自动点击或绕过真实验证码。
const DOUYIN_SEARCH_PACING_MIN_MS = 2000;
const DOUYIN_SEARCH_PACING_MAX_MS = 3000;
const DOUYIN_FILTER_PACING_MIN_MS = 1200;
const DOUYIN_FILTER_PACING_MAX_MS = 1900;
// 抖音搜索 URL 常被改写为无关键词路由。字面对不上时先给页面 6 秒完成改写，随后仍须
// 证明受信作品集合相对提交前发生替换；旧卡片稳定或仅懒加载新增都不能放行。
const BATCH_KEYWORD_RESULTS_KEYWORD_MATCH_GRACE_MS = 6000;

async function waitForDouyinSearchPacingWindow(
  tabId,
  shouldStop = null,
  {phase = 'search'} = {},
) {
  const isFilterPhase = String(phase || '').trim() === 'filter';
  const minMs = isFilterPhase
    ? DOUYIN_FILTER_PACING_MIN_MS
    : DOUYIN_SEARCH_PACING_MIN_MS;
  const maxMs = isFilterPhase
    ? DOUYIN_FILTER_PACING_MAX_MS
    : DOUYIN_SEARCH_PACING_MAX_MS;
  const delay = minMs + Math.random() * Math.max(0, maxMs - minMs);
  await waitMsWithStopAndTick(delay, shouldStop, {
    errorMessage: 'BATCH_CAPTURE_CANCELED',
    tickMs: 350,
    onTick: () => assertNoDouyinSearchSecurityChallengeInTab(tabId),
  });
}

async function runBatchSingleNoteEnhancements(
  recordId,
  {
    url = "",
    current = 0,
    total = 0,
    includeComments = false,
    includeBloggerMetrics = false,
    enableCommentLeadsFilter = null,
    commentsMaxDetectedItems = null,
    detailNavTimeoutMs = null,
    profileAfterNavWaitMs = null,
    preferWorksTabForBloggerMetrics = null,
    runnerTabId = null,
    shouldStop = null,
    onProgress = null,
  } = {},
) {
  if (!recordId || (!includeComments && !includeBloggerMetrics)) {
    return {
      ok: true,
      commentsResult: null,
      bloggerMetricsResult: null,
      error: null,
    };
  }

  const emitProgress = (progress = {}) => {
    if (typeof onProgress !== "function") {
      return;
    }
    onProgress({
      ...progress,
      current,
      total,
      url,
      phase: progress.phase || "capturing",
      message: progress.message || `正在采集第 ${current}/${total} 个...`,
      recordId,
    });
  };

  let commentsResult = null;
  let bloggerMetricsResult = null;
  let optionalFailed = false;

  try {
    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        commentsResult,
        bloggerMetricsResult,
        error: {
          code: 'BATCH_CAPTURE_CANCELED',
          message: 'BATCH_CAPTURE_CANCELED',
        },
      };
    }

    if (includeBloggerMetrics) {
      bloggerMetricsResult = await captureBloggerMetricsForSingleNoteRecord(
        recordId,
        {
          preferWorksTabForBloggerMetrics,
          detailNavTimeoutMs,
          profileAfterNavWaitMs,
          shouldStop,
          onProgress: emitProgress,
        },
      );
      if (!bloggerMetricsResult?.ok) {
        optionalFailed = true;
      }
    }

    if (typeof shouldStop === 'function' && shouldStop()) {
      return {
        ok: false,
        canceled: true,
        commentsResult,
        bloggerMetricsResult,
        error: {
          code: 'BATCH_CAPTURE_CANCELED',
          message: 'BATCH_CAPTURE_CANCELED',
        },
      };
    }

    if (includeComments) {
      commentsResult = await captureCommentsForSingleNoteRecord(recordId, {
        commentsMaxDetectedItems,
        enableCommentLeadsFilter,
        runnerTabId,
        onProgress: emitProgress,
      });
      if (!commentsResult?.ok) {
        optionalFailed = true;
      }
    }
  } catch (error) {
    optionalFailed = true;
    return {
      ok: false,
      commentsResult,
      bloggerMetricsResult,
      error: {
        code: "OPTIONAL_CAPTURE_FAILED",
        message: error?.message || "可选增强采集失败",
      },
    };
  }

  return {
    ok: !optionalFailed,
    canceled: false,
    commentsResult,
    bloggerMetricsResult,
    error:
      commentsResult?.error ||
      bloggerMetricsResult?.error ||
      (optionalFailed
        ? {
            code: "OPTIONAL_CAPTURE_FAILED",
            message: "可选增强采集失败",
          }
        : null),
  };
}

async function classifyTargetPageAvailabilityInTab(tabId, targetUrl) {
  if (!targetPageAvailabilityApi?.classifySnapshot) {
    return null;
  }
  try {
    const [snapshotExecution] = await chrome.scripting.executeScript({
      target: {tabId: Number(tabId)},
      func: () => {
        const bodyText = String(document.body?.innerText || "");
        // 弹窗通常挂在页面末尾。只截正文开头会在长推荐流中丢掉
        // “当前笔记暂时无法浏览”等真正决定业务结果的弹窗文案。
        const bodyWindow = bodyText.length <= 20000
          ? bodyText
          : `${bodyText.slice(0, 10000)}\n${bodyText.slice(-10000)}`;
        return {
          url: String(window.location.href || ""),
          title: String(document.title || ""),
          bodyText: bodyWindow,
        };
      },
    });
    return (
      targetPageAvailabilityApi.classifySnapshot({
        ...(snapshotExecution?.result || {}),
        platform: detectPlatformFromUrl(targetUrl),
        url: targetUrl,
      }) || null
    );
  } catch (error) {
    console.warn(
      "[CaptureSync] target page availability probe failed:",
      error,
    );
    return null;
  }
}

function buildUnavailableBatchCaptureResult(url, unavailablePage = null) {
  const observedAt = new Date().toISOString();
  return {
    url,
    ok: true,
    captured: false,
    recordIds: [],
    unavailable: true,
    businessOutcome:
      unavailablePage?.businessOutcome || "post_unavailable",
    availabilityStatus:
      unavailablePage?.availabilityStatus || "deleted",
    retryable: false,
    availability: {
      status: unavailablePage?.status || "unavailable",
      availabilityStatus:
        unavailablePage?.availabilityStatus || "deleted",
      reason:
        unavailablePage?.reason || "post_deleted_or_unavailable",
      code:
        unavailablePage?.code || "TARGET_POST_UNAVAILABLE",
      message:
        unavailablePage?.message || "平台提示该帖子已删除",
      evidence: Array.isArray(unavailablePage?.evidence)
        ? unavailablePage.evidence
        : [],
      observedAt,
    },
  };
}

async function probeDouyinDetailPreloadBeforeCapture(tabId, options = {}) {
  try {
    return await probeDetailPreloadSafety(tabId, options);
  } catch (error) {
    if (
      String(error?.code || "").trim().toUpperCase() !==
      "DOUYIN_DETAIL_NOT_READY"
    ) {
      throw error;
    }
    // 这里只放行“目标详情仍在加载”。真正的单帖采集内部还有更完整的
    // API/DOM 等待与身份校验链；删帖、安全验证、身份不匹配及未知错误
    // 都不能在这里降级，否则会把错误作品写回云端。
    return {
      ok: false,
      deferredToCapture: true,
      code: "DOUYIN_DETAIL_NOT_READY",
      currentUrl: String(error?.currentUrl || ""),
    };
  }
}

/**
 * 批量链接采集 — 在 runner tab 中逐个导航到 URL 并采集
 *
 * @param {Object} options
 * @param {string[]} options.urls - 链接列表
 * @param {string} options.mode - 'single' | 'blogger_notes'
 * @param {Object} options.captureParams - 传给 capture 脚本的参数
 * @param {boolean} [options.captureParams.includeBloggerProfileRecord] - 当 mode=blogger_notes 时是否先采集博主信息并入池
 * @param {number|null} [options.runnerTabId] - 显式指定执行标签页，避免用户切换活动标签页后误导航其他页面
 * @param {Function} [options.onProgress] - 进度回调 ({ current, total, url, phase })
 * @param {Function} [options.shouldStop] - 取消检测函数
 * @returns {Promise<{ ok: boolean, results: Array, stats: Object }>}
 */
export async function batchCaptureByUrls({
  urls = [],
  mode = "single",
  captureParams = {},
  runnerTabId: explicitRunnerTabId = null,
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!urls.length) {
    return { ok: true, results: [], stats: { total: 0, success: 0, failed: 0 } };
  }

  const normalizedExplicitRunnerTabId = Number(explicitRunnerTabId);
  const sourceTab =
    Number.isSafeInteger(normalizedExplicitRunnerTabId) &&
    normalizedExplicitRunnerTabId > 0
      ? await chrome.tabs.get(normalizedExplicitRunnerTabId)
      : await getCurrentActiveTab();
  const runnerCtx = await prepareDetailBatchRunnerContext({
    sourceTab,
  });
  const { runnerTabId } = runnerCtx;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;

  for (let i = 0; i < urls.length; i++) {
    if (typeof shouldStop === "function" && shouldStop()) {
      canceled = true;
      break;
    }

    const url = urls[i];
    let checkpointSession = null;
    let profileRecordIds = [];

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: urls.length,
        url,
        phase: "navigating",
        message: `正在导航到 (${i + 1}/${urls.length})...`,
      });
    }

    try {
      // 检查链接是否合法
      try {
        new URL(url);
      } catch (e) {
        throw new Error("链接格式错误");
      }

      // 定向作品连续采集不能只看 tab.status。抖音是单页应用，切换 modal_id
      // 时标签页可能仍显示 complete，但详情 DOM 还是上一条作品。必须等地址中的
      // 作品 ID 已切到当前目标后，才允许进入采集，避免整批结果串到前一条。
      await openUrlInTab(runnerTabId, url, {
        timeoutMs: DETAIL_CAPTURE_NAV_TIMEOUT_MS,
        shouldStop,
        active: true,
      });

      const shouldDetectUnavailableTarget =
        mode === "single" &&
        captureParams.detectUnavailableTargetPage === true &&
        targetPageAvailabilityApi?.classifySnapshot;
      // 小红书“你访问的页面不见了”会在约 2 秒后自动跳回首页。
      // openUrlInTab 已等到目标文档加载完成，先立即取一次页面证据，
      // 避免固定渲染等待正好错过这个短暂但明确的删帖状态。
      let unavailablePage = shouldDetectUnavailableTarget
        ? await classifyTargetPageAvailabilityInTab(runnerTabId, url)
        : null;

      // 等待页面渲染
      await waitMsWithStop(
        BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
        shouldStop,
        "BATCH_CAPTURE_CANCELED",
      );

      if (shouldDetectUnavailableTarget) {
        unavailablePage =
          unavailablePage ||
          (await classifyTargetPageAvailabilityInTab(runnerTabId, url));
        if (unavailablePage?.unavailable === true) {
          results.push(
            buildUnavailableBatchCaptureResult(url, unavailablePage),
          );
          successCount++;
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: urls.length,
              url,
              phase: "target_unavailable",
              businessOutcome: unavailablePage.businessOutcome,
              message: "平台提示该帖子已删除或不可用，已记录状态",
            });
          }
          continue;
        }
      }

      if (
        mode === "single" &&
        detectPlatformFromUrl(url) === "douyin" &&
        extractNoteId(url)
      ) {
        await probeDouyinDetailPreloadBeforeCapture(runnerTabId, {
          targetUrl: url,
          waitForDouyinReady: true,
          requireVisibleDetailRoot: true,
          shouldStop,
          timeoutMs: DOUYIN_COMMENT_RECOVERY_READY_TIMEOUT_MS,
        });
      }

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: urls.length,
          url,
          phase: "capturing",
          message: `正在采集第 ${i + 1}/${urls.length} 个...`,
        });
      }

      let resolvedProfileMetrics = captureParams.profileMetrics;
      const shouldCaptureBloggerProfileFirst =
        mode === "blogger_notes" &&
        Boolean(captureParams.includeBloggerProfileRecord);
      if (shouldCaptureBloggerProfileFirst) {
        const profileCaptureResult = await captureInTab(runnerTabId, {
          mode: "blogger_profile",
        });
        if (isCaptureCanceledResult(profileCaptureResult)) {
          canceled = true;
          break;
        }
        if (!profileCaptureResult?.ok) {
          throw new Error(profileCaptureResult?.error?.message || "博主信息采集失败");
        }

        const profilePayload =
          profileCaptureResult?.data &&
          typeof profileCaptureResult.data === "object"
            ? profileCaptureResult.data
            : null;
        if (profilePayload) {
          resolvedProfileMetrics = profilePayload;
        }

        const profileRecordsToSave = buildRecordsForStorage(profileCaptureResult);
        if (profileRecordsToSave.length > 0) {
          const savedProfiles =
            profileRecordsToSave.length === 1
              ? [await addRecord(profileRecordsToSave[0])]
              : await addRecords(profileRecordsToSave);
          profileRecordIds = savedProfiles
            .map((record) => record?.id)
            .filter(Boolean);
          trackCoreCaptureSuccess(profileRecordIds.length, {
            mode: 'blogger_profile',
            source: 'batch_profile_capture',
          });
        }
      }

      // 采集（注：这里重用 captureInTab）
      const singleNoteEnhancementOptions =
        mode === "single"
          ? {
              expectedNoteId:
                detectPlatformFromUrl(url) === "douyin"
                  ? extractNoteId(url)
                  : "",
              includeComments: Boolean(captureParams.includeComments),
              includeBloggerMetrics: Boolean(captureParams.includeBloggerMetrics),
              enableCommentLeadsFilter: captureParams.enableCommentLeadsFilter,
              commentsMaxDetectedItems:
                captureParams.commentsMaxDetectedItems ?? captureParams.commentsMaxItems,
              detailNavTimeoutMs: captureParams.detailNavTimeoutMs,
              profileAfterNavWaitMs: captureParams.profileAfterNavWaitMs,
              preferWorksTabForBloggerMetrics:
                typeof captureParams.preferWorksTabForBloggerMetrics === "boolean"
                  ? captureParams.preferWorksTabForBloggerMetrics
                  : Boolean(captureParams.includeBloggerMetrics) &&
                    detectPlatformFromUrl(url) === "douyin" &&
                    isDouyinContentFlowUrl(url),
            }
          : null;
      const effectiveCaptureParams =
        mode === "single" && singleNoteEnhancementOptions
          ? {
              ...captureParams,
              expectedNoteId:
                singleNoteEnhancementOptions.expectedNoteId,
              preferWorksTabForBloggerMetrics:
                singleNoteEnhancementOptions.preferWorksTabForBloggerMetrics,
            }
          : mode === "blogger_notes" &&
              resolvedProfileMetrics &&
              typeof resolvedProfileMetrics === "object"
            ? {
                ...captureParams,
                profileMetrics: resolvedProfileMetrics,
              }
            : captureParams;
      checkpointSession = beginListCaptureCheckpointSession({
        mode,
        source: 'batch_link_capture',
      });
      let captureResult = await captureInTab(runnerTabId, {
        mode,
        captureParams: effectiveCaptureParams,
      });

      let unavailableAfterCapture = null;
      const captureErrorCode = String(
        captureResult?.error?.code || "",
      ).toUpperCase();
      const targetPlatform = detectPlatformFromUrl(url);
      const shouldRecheckUnavailableXhsTarget =
        mode === "single" &&
        captureParams.detectUnavailableTargetPage === true &&
        targetPlatform === "xiaohongshu" &&
        captureResult?.ok !== true;
      if (shouldRecheckUnavailableXhsTarget) {
        // 小红书的不可用弹窗会把地址退回 /explore。页面信号有时晚于
        // 首次导航探针出现，此时单帖采集会先报“无法从 URL 提取笔记 ID”。
        // 失败后再读一次高置信不可用页信号，避免把删帖当普通采集失败重试。
        unavailableAfterCapture =
          await classifyTargetPageAvailabilityInTab(runnerTabId, url);
      }
      const shouldRecheckUnavailableDouyinTarget =
        mode === "single" &&
        captureParams.detectUnavailableTargetPage === true &&
        targetPlatform === "douyin" &&
        [
          "DOUYIN_CONTENT_UNAVAILABLE",
          "DOUYIN_DETAIL_ID_MISMATCH",
          "DOUYIN_DETAIL_NOT_READY",
        ].includes(captureErrorCode);
      if (shouldRecheckUnavailableDouyinTarget) {
        if (captureErrorCode === "DOUYIN_CONTENT_UNAVAILABLE") {
          unavailableAfterCapture =
            (await classifyTargetPageAvailabilityInTab(runnerTabId, url)) ||
            {
              unavailable: true,
              availabilityStatus: "deleted",
              message: "平台提示该帖子已删除",
              evidence: ["douyin_content_unavailable"],
            };
        } else {
          // 删除页 5 秒后会自动播放推荐作品。若捕获到串号或未就绪，
          // 重新打开一次原目标并立即检查删除文案，避免把推荐作品写回。
          await openUrlInTab(runnerTabId, url, {
            timeoutMs: DETAIL_CAPTURE_NAV_TIMEOUT_MS,
            shouldStop,
            active: true,
          });
          await waitMsWithStop(
            500,
            shouldStop,
            "BATCH_CAPTURE_CANCELED",
          );
          unavailableAfterCapture =
            await classifyTargetPageAvailabilityInTab(runnerTabId, url);
          if (!unavailableAfterCapture?.unavailable) {
            await probeDouyinDetailPreloadBeforeCapture(runnerTabId, {
              targetUrl: url,
              waitForDouyinReady: true,
              requireVisibleDetailRoot: true,
              shouldStop,
              timeoutMs: DOUYIN_COMMENT_RECOVERY_READY_TIMEOUT_MS,
            });
            captureResult = await captureInTab(runnerTabId, {
              mode,
              captureParams: effectiveCaptureParams,
            });
          }
        }
      }

      if (isCaptureCanceledResult(captureResult)) {
        canceled = true;
        break;
      }
      if (typeof shouldStop === "function" && shouldStop()) {
        canceled = true;
        break;
      }

      // 入池
      if (unavailableAfterCapture?.unavailable === true) {
        results.push(
          buildUnavailableBatchCaptureResult(
            url,
            unavailableAfterCapture,
          ),
        );
        successCount++;
      } else if (captureResult?.ok) {
        const saveResult = await saveCaptureResultRecords(captureResult, {
          session: checkpointSession,
        });
        const savedRecords = Array.isArray(saveResult.savedRecords)
          ? saveResult.savedRecords
          : [];
        const noteRecordIds = Array.isArray(saveResult.recordIds)
          ? saveResult.recordIds
          : [];
        if (noteRecordIds.length > 0) {
          trackCoreCaptureSuccess(savedRecords.length, {
            mode,
            source: 'batch_link_capture',
          });
          const recordIds = [...profileRecordIds, ...noteRecordIds];
          const enhancementResult =
            mode === "single" && noteRecordIds.length === 1
              ? await runBatchSingleNoteEnhancements(noteRecordIds[0], {
                  url,
                  current: i + 1,
                  total: urls.length,
                  runnerTabId,
                  shouldStop,
                  onProgress,
                  ...singleNoteEnhancementOptions,
                })
              : null;
          const canceledDuringEnhancement = Boolean(
            enhancementResult?.canceled ||
              isBatchCaptureCanceledError(enhancementResult?.error) ||
              (typeof shouldStop === "function" && shouldStop()),
          );
          results.push({
            url,
            ok: true,
            recordIds,
            partial: Boolean(enhancementResult && !enhancementResult.ok),
            scanComplete: !(enhancementResult && !enhancementResult.ok),
            canceled: canceledDuringEnhancement,
            commentsResult: enhancementResult?.commentsResult || null,
            bloggerMetricsResult: enhancementResult?.bloggerMetricsResult || null,
            captureCacheStats: saveResult.cacheStats || null,
            warning:
              enhancementResult && !enhancementResult.ok
                ? enhancementResult.error?.message || "可选增强采集失败"
                : "",
            ...(enhancementResult && !enhancementResult.ok
              ? {
                  error:
                    enhancementResult.error &&
                    typeof enhancementResult.error === "object"
                      ? enhancementResult.error
                      : {
                          code: String(
                            enhancementResult.errorCode ||
                              "CAPTURE_ENHANCEMENT_INCOMPLETE",
                          ),
                          message:
                            enhancementResult.error?.message ||
                            enhancementResult.message ||
                            "采集增强未完整完成",
                          retryable: enhancementResult.retryable !== false,
                        },
                }
              : {}),
          });
          successCount++;
          if (canceledDuringEnhancement) {
            canceled = true;
            break;
          }
        } else {
          results.push({
            url,
            ok: true,
            recordIds: profileRecordIds,
            scanComplete: true,
            captureCacheStats: saveResult.cacheStats || null,
          });
          successCount++;
        }
      } else {
        if (checkpointSession?.queue) {
          await checkpointSession.queue.catch(() => null);
        }
        const partialRecordIds = collectListCaptureSessionRecordIds(
          checkpointSession,
        );
        if (partialRecordIds.length > 0 || profileRecordIds.length > 0) {
          results.push({
            url,
            ok: false,
            partial: true,
            scanComplete: false,
            recordIds: [...profileRecordIds, ...partialRecordIds],
            captureCacheStats: createListCaptureCacheStats(checkpointSession),
            warning: captureResult?.error?.message || "采集未完整完成",
            error:
              captureResult?.error && typeof captureResult.error === "object"
                ? captureResult.error
                : {
                    code: String(captureResult?.errorCode || "CAPTURE_INCOMPLETE"),
                    message:
                      captureResult?.error?.message || "采集未完整完成",
                    retryable: true,
                  },
          });
          failedCount++;
        } else {
          results.push({
            url,
            ok: false,
            error: captureResult?.error?.message || "采集失败",
          });
          failedCount++;
        }
      }
    } catch (error) {
      if (isBatchCaptureCanceledError(error)) {
        canceled = true;
        break;
      }
      if (
        mode === "single" &&
        captureParams.detectUnavailableTargetPage === true &&
        detectPlatformFromUrl(url) === "douyin" &&
        String(error?.code || "").toUpperCase() ===
          "DOUYIN_CONTENT_UNAVAILABLE"
      ) {
        const unavailableClassification =
          (await classifyTargetPageAvailabilityInTab(runnerTabId, url)) ||
          {
            unavailable: true,
            availabilityStatus: "deleted",
            message: "平台提示该帖子已删除",
            evidence: ["douyin_content_unavailable"],
          };
        results.push(
          buildUnavailableBatchCaptureResult(
            url,
            unavailableClassification,
          ),
        );
        successCount++;
      } else {
        if (checkpointSession?.queue) {
          await checkpointSession.queue.catch(() => null);
        }
        const partialRecordIds = collectListCaptureSessionRecordIds(
          checkpointSession,
        );
        if (partialRecordIds.length > 0 || profileRecordIds.length > 0) {
          results.push({
            url,
            ok: false,
            partial: true,
            scanComplete: false,
            recordIds: [...profileRecordIds, ...partialRecordIds],
            captureCacheStats: createListCaptureCacheStats(checkpointSession),
            warning: error.message || "采集未完整完成",
            error: {
              code: String(error?.code || "CAPTURE_INCOMPLETE"),
              category: String(error?.category || ""),
              message: error.message || "采集未完整完成",
              retryable: error?.retryable !== false,
              ...(error?.securityBlocked === true
                ? {securityBlocked: true}
                : {}),
              ...(error?.platformSafetyBlocked === true
                ? {platformSafetyBlocked: true}
                : {}),
              ...(error?.requiresManualAction === true
                ? {requiresManualAction: true}
                : {}),
              ...(error?.securityEvidence?.confirmed === true
                ? {securityEvidence: error.securityEvidence}
                : {}),
            },
          });
          failedCount++;
        } else {
          results.push({
            url,
            ok: false,
            error: error.message,
          });
          failedCount++;
        }
      }
    } finally {
      if (checkpointSession?.queue) {
        await checkpointSession.queue.catch(() => null);
      }
      finishListCaptureCheckpointSession(checkpointSession);
    }

    // 随机延迟
    if (i < urls.length - 1) {
      const delay =
        BATCH_KEYWORD_DELAY_MIN_MS +
        Math.random() *
          (BATCH_KEYWORD_DELAY_MAX_MS - BATCH_KEYWORD_DELAY_MIN_MS);
      try {
        await waitMsWithStop(delay, shouldStop, "BATCH_CAPTURE_CANCELED");
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  // 恢复原始页面
  if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
    try {
      await chrome.tabs.update(runnerTabId, { url: runnerCtx.sourcePageUrl });
    } catch {
      // ignore
    }
  }

  if (onProgress) {
    onProgress({
      current: successCount + failedCount,
      total: urls.length,
      url: "",
      phase: canceled ? "canceled" : "done",
      message: canceled
        ? `批量采集已停止：已处理 ${successCount + failedCount}/${urls.length}，成功 ${successCount}，失败 ${failedCount}`
        : `批量采集完成：成功 ${successCount}，失败 ${failedCount}`,
    });
  }

  const partialCount = results.filter((entry) => entry?.partial === true).length;
  const scanComplete = !canceled && failedCount === 0 && partialCount === 0;
  return {
    ok: scanComplete,
    canceled,
    partial: partialCount > 0,
    scanComplete,
    incompleteReason: scanComplete
      ? ""
      : canceled
        ? "capture_canceled"
        : partialCount > 0
          ? "partial_capture"
          : "capture_failed",
    results,
    stats: {
      total: urls.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
      partial: partialCount,
    },
  };
}

/**
 * 批量关键词采集 — 在 runner tab 中逐个导航到关键词搜索 URL 并采集
 *
 * @param {Object} options
 * @param {string[]} options.keywords - 关键词列表
 * @param {string} options.platform - 平台标识 ('xiaohongshu' | 'douyin')
 * @param {string} options.baseSearchUrl - 当前搜索页 URL（用于构建同平台搜索 URL）
 * @param {Object} options.captureParams - 传给 captureKeywordNotes 的参数
 * @param {string} [options.captureTaskId] - 持久 Debug/工作页所属任务
 * @param {Function} [options.afterKeywordCapture] - 单个关键词入池后触发，可用于立即采集增强
 * @param {Function} [options.onKeywordSettled] - 单个关键词收口后触发，用于持久化无人值守检查点
 * @param {Function} [options.onProgress] - 进度回调 ({ current, total, keyword, phase })
 * @param {Function} [options.shouldStop] - 取消检测函数
 * @returns {Promise<{ ok: boolean, results: Array, stats: Object }>}
 */
function hasActiveBatchSearchFilters(searchFilters = {}) {
  return Object.values(searchFilters || {}).some((value) =>
    Boolean(String(value || '').trim()),
  );
}

// 采集前切搜索「排序 / 范围」:转发到 content 的 applyBatchSearchFilters。
// 普通筛选失败仍由后续结果就绪检查兜底；抖音明确显示“服务出现异常”时
// 保留结构化的单关键词错误，由批处理跳过本词并继续，而不是误判为账号风控。
function createSearchFilterApplicationError(result = null) {
  const failedFields = Array.isArray(result?.failedFields)
    ? result.failedFields.map((field) => String(field || '').trim()).filter(Boolean)
    : [];
  const error = new Error(
    failedFields.length > 0
      ? `搜索筛选未完整生效：${failedFields.join('、')}`
      : '无法确认搜索筛选已完整生效',
  );
  error.code = 'SEARCH_FILTER_APPLICATION_FAILED';
  error.category = 'filter_verification';
  error.fatal = true;
  error.stopBatch = true;
  error.requiresManualAction = true;
  error.retryable = false;
  error.filterResult = result;
  return error;
}

async function applySearchFiltersInTab(
  tabId,
  searchFilters = {},
  {requireVerifiedFilters = false} = {},
) {
  try {
    await assertNoDouyinSearchSecurityChallengeInTab(tabId);
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: Number(tabId),
      payload: {
        action: 'applyBatchSearchFilters',
        ...searchFilters,
        verifyDefaults: requireVerifiedFilters,
      },
    });
    const contentResponse = response?.data;
    const responseError =
      response?.ok === false
        ? response?.error
        : contentResponse?.ok === false
          ? contentResponse?.error
          : null;
    if (isDouyinSearchServiceAbnormalError(responseError)) {
      throw createDouyinSearchServiceAbnormalError({
        message: responseError?.message,
      });
    }
    if (isDouyinSearchSecurityChallengeError(responseError)) {
      throw createDouyinSearchSecurityChallengeError({
        message: responseError?.message,
      });
    }
    if (responseError) {
      if (requireVerifiedFilters) {
        throw createSearchFilterApplicationError(responseError);
      }
      return null;
    }
    const result = contentResponse?.data ?? contentResponse ?? null;
    if (requireVerifiedFilters && result?.complete !== true) {
      throw createSearchFilterApplicationError(result);
    }
    return result;
  } catch (error) {
    if (
      isDouyinSearchServiceAbnormalError(error) ||
      isDouyinSearchSecurityChallengeError(error)
    ) {
      throw error;
    }
    if (
      String(error?.code || '').trim().toUpperCase() ===
      'SEARCH_FILTER_APPLICATION_FAILED'
    ) {
      throw error;
    }
    return null;
  }
}

function formatEnhanceSkipReason(reason = '') {
  const normalized = String(reason || '').trim();
  const reasonMap = {
    disabled: '未开启',
    auth_required: '未授权',
    unsupported_platform: '当前平台不支持',
    no_target_records: '没有待增强记录',
    all_targets_settled: '本轮记录均已完成增强',
    record_ids_unresolved: '采集结果尚未写入本地数据池',
    missing_note_url: '缺少可访问链接',
    no_record_ids: '本关键词没有可增强记录',
  };
  return reasonMap[normalized] || normalized || '无可增强记录';
}

function buildInterKeywordDelayMessage({
  keyword = '',
  delay = 0,
  hasEnhanceStep = false,
  keywordResult = null,
} = {}) {
  const seconds = Math.round(Number(delay || 0) / 1000);
  if (
    String(keywordResult?.errorCode || '').trim().toUpperCase() ===
    DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE
  ) {
    return `「${keyword}」搜索服务暂时异常，已跳过本词，${seconds} 秒后尝试下一个关键词…`;
  }
  if (!hasEnhanceStep) {
    return `已采「${keyword}」，${seconds} 秒后再搜下一个关键词(防风控·随机间隔)…`;
  }

  const enhanceStatus = String(keywordResult?.enhanceStatus || '').trim();
  if (enhanceStatus === 'done') {
    return `已完成「${keyword}」列表采集与采集增强，${seconds} 秒后再搜下一个关键词(防风控·随机间隔)…`;
  }
  if (enhanceStatus === 'skipped') {
    const reason = formatEnhanceSkipReason(keywordResult?.enhanceSkipReason);
    return `已采「${keyword}」，采集增强已跳过（${reason}），${seconds} 秒后再搜下一个关键词(防风控·随机间隔)…`;
  }
  if (enhanceStatus === 'failed') {
    return `已采「${keyword}」，采集增强未完整完成，${seconds} 秒后再搜下一个关键词(防风控·随机间隔)…`;
  }

  return `已采「${keyword}」，采集增强未执行，${seconds} 秒后再搜下一个关键词(防风控·随机间隔)…`;
}

export async function batchCaptureByKeywords({
  keywords = [],
  platform = '',
  baseSearchUrl = '',
  sourceTabId = null,
  captureParams = {},
  captureTaskId = '',
  searchFilters = null,
  disableAutomaticSearchRetry = false,
  requireVerifiedFilters = false,
  initialSearchEvidence = null,
  afterKeywordCapture = null,
  onKeywordSettled = null,
  waitForegroundTabId = null,
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!keywords.length) {
    return { ok: true, results: [], stats: { total: 0, success: 0, failed: 0 } };
  }

  const preferredSourceTabId = Number(sourceTabId);
  let sourceTab = null;
  if (Number.isSafeInteger(preferredSourceTabId) && preferredSourceTabId > 0) {
    try {
      sourceTab = await chrome.tabs.get(preferredSourceTabId);
    } catch {
      throw new Error('指定的无人值守采集页已关闭，任务已停止以免误采其它标签页');
    }
    if (!sourceTab?.id) {
      throw new Error('指定的无人值守采集页不可用，任务已停止以免误采其它标签页');
    }
  } else {
    sourceTab = await getCurrentActiveTab();
  }
  const runnerCtx = await prepareDetailBatchRunnerContext({ sourceTab });
  let runnerTabId = Number(runnerCtx.runnerTabId);
  const runnerReplacementEvents = chrome?.tabs?.onReplaced || null;
  const handleRunnerTabReplacement = (addedTabId, removedTabId) => {
    const normalizedAddedTabId = Number(addedTabId);
    const normalizedRemovedTabId = Number(removedTabId);
    if (
      normalizedRemovedTabId !== runnerTabId ||
      !Number.isSafeInteger(normalizedAddedTabId) ||
      normalizedAddedTabId <= 0
    ) {
      return;
    }
    runnerTabId = normalizedAddedTabId;
    runnerCtx.runnerTabId = normalizedAddedTabId;
    if (Number(runnerCtx.sourceTabId) === normalizedRemovedTabId) {
      runnerCtx.sourceTabId = normalizedAddedTabId;
    }
  };
  if (typeof runnerReplacementEvents?.addListener === 'function') {
    runnerReplacementEvents.addListener(handleRunnerTabReplacement);
  }
  const readStopRequested = () => {
    if (typeof shouldStop !== 'function') return false;
    try {
      return shouldStop() === true;
    } catch {
      // A broken stop predicate must never make an unattended task continue
      // indefinitely. Treat it as an explicit stop request.
      return true;
    }
  };
  const isRecoverableKeywordInterruption = (value) => {
    const error = value?.error && typeof value.error === 'object'
      ? value.error
      : null;
    const code = String(
      error?.code || value?.code || value?.reason || '',
    ).trim().toUpperCase();
    const category = String(value?.category || error?.category || '')
      .trim()
      .toLowerCase();
    return Boolean(
      value?.recoverable === true ||
        value?.runnerInterrupted === true ||
        category === 'context_interrupted' ||
        new Set([
          'CONTEXT_INTERRUPTED',
          'RUNNER_TAB_UNAVAILABLE',
          'TASK_TAB_GROUP_UNAVAILABLE',
          'CAPTURE_TASK_SIDEBAR_OWNER_DISCONNECTED',
          'SIDEBAR_OWNER_DISCONNECTED',
          'NATIVE_DEBUG_CANCELED',
          'SOURCE_TAB_REMOVED',
        ]).has(code)
    );
  };
  const isExplicitFatalKeywordFailure = (value) => {
    const error = value?.error && typeof value.error === 'object'
      ? value.error
      : null;
    const code = String(error?.code || value?.code || '').trim().toUpperCase();
    return Boolean(
      value?.fatal === true ||
        error?.fatal === true ||
        value?.stopBatch === true ||
        code.startsWith('FATAL_')
    );
  };
  const externalOnProgress =
    typeof onProgress === 'function' ? onProgress : null;
  onProgress = externalOnProgress
    ? (progress) => {
        try {
          const callbackResult = externalOnProgress(progress);
          if (callbackResult?.catch) {
            callbackResult.catch((error) => {
              console.warn('[CaptureSync] Batch progress callback failed:', error);
            });
          }
        } catch (error) {
          console.warn('[CaptureSync] Batch progress callback failed:', error);
        }
      }
    : null;

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;
  let securityBlocked = false;
  let fatal = false;
  let recoveryRequired = false;
  let blockingError = null;
  const reusableInitialSearchEvidence =
    initialSearchEvidence &&
    typeof initialSearchEvidence === 'object' &&
    !Array.isArray(initialSearchEvidence)
      ? initialSearchEvidence
      : null;
  let initialSearchEvidenceConsumed = false;
  const resolveKeywordFailure = (...values) => {
    const candidates = values.filter(Boolean);
    const structured = candidates
      .map((value) =>
        value?.error && typeof value.error === 'object'
          ? value.error
          : value,
      )
      .find((value) => value && typeof value === 'object') || {};
    const message =
      candidates
        .map((value) =>
          String(
            value?.error?.message ||
              (typeof value?.error === 'string' ? value.error : '') ||
              value?.message ||
              '',
          ).trim(),
        )
        .find(Boolean) || '';
    const errorCode =
      candidates
        .map((value) =>
          String(
            value?.error?.code ||
              value?.errorCode ||
              value?.code ||
              '',
          ).trim(),
        )
        .find(Boolean) || '';
    const safetyEvidence = {
      ...structured,
      ...(errorCode ? {code: errorCode} : {}),
      ...(message ? {message} : {}),
      securityBlocked: candidates.some(
        (value) =>
          value?.securityBlocked === true ||
          value?.error?.securityBlocked === true,
      ),
      platformSafetyBlocked: candidates.some(
        (value) =>
          value?.platformSafetyBlocked === true ||
          value?.error?.platformSafetyBlocked === true,
      ),
    };
    const confirmedSecurityEvidence = candidates
      .map((value) =>
        value?.securityEvidence || value?.error?.securityEvidence,
      )
      .find((value) => value?.confirmed === true) || null;
    return {
      code: errorCode,
      message,
      category:
        candidates
          .map((value) =>
            String(
              value?.error?.category ||
                value?.category ||
                '',
            ).trim(),
          )
          .find(Boolean) || '',
      securityBlocked: isUnattendedSafetyBlock(safetyEvidence),
      platformSafetyBlocked: candidates.some(
        (value) =>
          value?.platformSafetyBlocked === true ||
          value?.error?.platformSafetyBlocked === true,
      ),
      requiresManualAction: candidates.some(
        (value) =>
          value?.requiresManualAction === true ||
          value?.error?.requiresManualAction === true,
      ),
      securityEvidence: confirmedSecurityEvidence,
      fatal: candidates.some(
        (value) =>
          value?.fatal === true ||
          value?.stopBatch === true ||
          value?.error?.fatal === true ||
          value?.error?.stopBatch === true,
      ),
    };
  };
  const normalizeKeywordSearchReadiness = (value) => {
    if (value && typeof value === 'object') {
      return {
        ready: value.ready === true,
        confirmedEmpty: value.confirmedEmpty === true,
        emptyMessage: String(value.emptyMessage || '').trim(),
        pageUrl: String(value.pageUrl || '').trim(),
        readinessCode: String(value.readinessCode || '').trim(),
        slowProgressProbeUsed: value.slowProgressProbeUsed === true,
        slowProgressReason: String(value.slowProgressReason || '').trim(),
        waitedMs: Math.max(0, Number(value.waitedMs) || 0),
      };
    }
    return {
      ready: value === true,
      confirmedEmpty: false,
      emptyMessage: '',
      pageUrl: '',
      readinessCode: '',
      slowProgressProbeUsed: false,
      slowProgressReason: '',
      waitedMs: 0,
    };
  };
  const createDouyinSlowProgressReporter = ({keyword, current, total, stage}) =>
    !onProgress
      ? null
      : (probe = {}) => {
          onProgress({
            current,
            total,
            keyword,
            phase: 'waiting_results',
            stage: String(stage || 'results_visible_unconfirmed'),
            readinessCode: String(probe.readinessCode || ''),
            slowProgressProbeUsed: true,
            slowProgressReason: String(probe.reason || ''),
            remainingMs: Math.max(0, Number(probe.extensionMs) || 0),
            message:
              stage === 'filtered_results_visible_unconfirmed'
                ? `已看到「${keyword}」筛选后的结果，正在等待本次筛选代际确认(${current}/${total})...`
                : `已看到「${keyword}」的搜索结果，正在等待本次搜索代际确认(${current}/${total})...`,
          });
        };
  const throwConfirmedEmptySearchResult = (keyword, readiness) => {
    if (!readiness?.confirmedEmpty) return;
    const error = new Error(
      readiness.emptyMessage ||
        `「${keyword}」在当前筛选范围内没有匹配内容`,
    );
    error.code = 'CONFIRMED_EMPTY_SEARCH_RESULTS';
    error.category = 'no_matching_results';
    error.confirmedEmpty = true;
    error.noResults = true;
    error.resultKind = 'no_matching_results';
    error.retryable = false;
    error.keywordScoped = true;
    error.pageUrl = readiness.pageUrl || '';
    throw error;
  };

  try {
  for (let i = 0; i < keywords.length; i++) {
    if (readStopRequested()) {
      canceled = true;
      break;
    }

    const keyword = keywords[i];
    let keywordResult = null;

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: keywords.length,
        keyword,
        phase: isDouyinPlatform(platform) ? 'submitting_search' : 'navigating',
        message: isDouyinPlatform(platform)
          ? `正在切换并搜索关键词「${keyword}」(${i + 1}/${keywords.length})...`
          : `正在导航到关键词「${keyword}」(${i + 1}/${keywords.length})...`,
      });
    }

    try {
      if (isDouyinPlatform(platform)) {
        await assertNoDouyinSearchSecurityChallengeInTab(runnerTabId);
      }
      // 构建搜索 URL
      const searchUrl = buildKeywordSearchUrl(keyword, platform, baseSearchUrl);
      const reuseInitialSearch = Boolean(
        !initialSearchEvidenceConsumed &&
        reusableInitialSearchEvidence?.ready === true &&
        String(reusableInitialSearchEvidence.keyword || '').trim() === keyword &&
        String(reusableInitialSearchEvidence.platform || '').trim() === platform &&
        Number(reusableInitialSearchEvidence.tabId) === runnerTabId &&
        (
          !isDouyinPlatform(platform) ||
          reusableInitialSearchEvidence.navigationTransitionAccepted === true ||
          reusableInitialSearchEvidence.submitAccepted === true
        )
      );
      if (reuseInitialSearch) {
        initialSearchEvidenceConsumed = true;
      }

      let douyinSearchTransition = null;
      if (isDouyinPlatform(platform)) {
        douyinSearchTransition = reuseInitialSearch
          ? {
              baselineCaptured:
                reusableInitialSearchEvidence.baselineCaptured === true,
              previousWorkIds: Array.isArray(
                reusableInitialSearchEvidence.previousWorkIds,
              )
                ? reusableInitialSearchEvidence.previousWorkIds
                : [],
              submitAccepted:
                reusableInitialSearchEvidence.submitAccepted === true,
              submissionNonce: String(
                reusableInitialSearchEvidence.submissionNonce || '',
              ),
              navigationTransitionAccepted:
                reusableInitialSearchEvidence.navigationTransitionAccepted ===
                true,
            }
          : await switchDouyinKeywordSearchInTab(
              runnerTabId,
              keyword,
              searchUrl,
              shouldStop,
            );
        await waitForDouyinSearchPacingWindow(
          runnerTabId,
          shouldStop,
          {phase: 'search'},
        );
      } else {
        // The unattended bootstrap already opened the first keyword. Reuse
        // that exact bound tab once; later keywords still navigate normally.
        if (!reuseInitialSearch) {
          await navigateToSearchUrl(runnerTabId, searchUrl, shouldStop);
        }
      }
      if (captureTaskId) {
        await setCaptureTaskTakeoverStateInTab({
          tabId: runnerTabId,
          taskId: captureTaskId,
          active: true,
          label: 'AI 正在接管',
        });
      }

      // 抖音结果探针会每 300ms 检查“服务出现异常”，不要先固定等 2 秒。
      // 稳定异常且没有作品时，本词按 0 条正常完成并继续；其它平台保留原有渲染宽限。
      if (!isDouyinPlatform(platform)) {
        await waitMsWithStop(
          BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
          shouldStop,
          'BATCH_CAPTURE_CANCELED',
        );
      }
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'waiting_results',
          message: `正在等待「${keyword}」搜索结果加载(${i + 1}/${keywords.length})...`,
        });
      }
      const initialReadiness = normalizeKeywordSearchReadiness(
        await waitForKeywordSearchResultsInTab(
          runnerTabId,
          platform,
          shouldStop,
          {
            keyword,
            returnState: true,
            requireResultTransition: isDouyinPlatform(platform),
            previousWorkIds:
              douyinSearchTransition?.baselineCaptured === true
                ? douyinSearchTransition.previousWorkIds
                : null,
            submitAccepted:
              douyinSearchTransition?.submitAccepted === true,
            submissionNonce:
              douyinSearchTransition?.submissionNonce || '',
            navigationTransitionAccepted:
              douyinSearchTransition?.navigationTransitionAccepted === true,
            onSlowProgress: createDouyinSlowProgressReporter({
              keyword,
              current: i + 1,
              total: keywords.length,
              stage: 'results_visible_unconfirmed',
            }),
          },
        ),
      );
      throwConfirmedEmptySearchResult(keyword, initialReadiness);
      const initialResultsReady = initialReadiness.ready;
      if (!initialResultsReady && isDouyinPlatform(platform)) {
        throw new Error(
          `「${keyword}」搜索结果页未就绪，已结束本次尝试并保留后续关键词`,
        );
      }

      // 按需切换搜索「排序 / 范围」(默认值则跳过)。
      // 关键:筛选后结果没加载(如抖音「服务出现异常」)绝不能继续采——有界重试会
      // 重新点搜索,把筛选清空,采回来的就是未筛选(可能好几年前)的内容(客户投诉根源)。
      // 抖音撞到异常页时,像手动一样重新点一次搜索并把筛选重挂;仍无作品则本词按 0 条收口,宁缺勿错。
      if (hasActiveBatchSearchFilters(searchFilters)) {
        let filteredResultsReady = false;
        const maxFilterAttempts =
          isDouyinPlatform(platform) && !disableAutomaticSearchRetry ? 2 : 1;
        for (
          let filterAttempt = 0;
          filterAttempt < maxFilterAttempts && !filteredResultsReady;
          filterAttempt += 1
        ) {
          if (filterAttempt > 0) {
            // 上一轮筛选后页面异常:重新提交搜索(会重置筛选,故下面必须重挂)
            if (onProgress) {
              onProgress({
                current: i + 1,
                total: keywords.length,
                keyword,
                phase: 'filtering',
                message: `「${keyword}」筛选后页面异常，正在重新搜索并重挂筛选(${i + 1}/${keywords.length})...`,
              });
            }
            const retrySearchTransition = await submitKeywordSearchInTab(
              runnerTabId,
              platform,
              keyword,
              shouldStop,
              {reason: 'filter_generation_recovery'},
            );
            await waitForDouyinSearchPacingWindow(
              runnerTabId,
              shouldStop,
              {phase: 'search'},
            );
            const retrySearchReadiness = normalizeKeywordSearchReadiness(
              await waitForKeywordSearchResultsInTab(
                runnerTabId,
                platform,
                shouldStop,
                {
                  keyword,
                  returnState: true,
                  requireResultTransition: true,
                  previousWorkIds:
                    retrySearchTransition?.baselineCaptured === true
                      ? retrySearchTransition.previousWorkIds
                      : null,
                  submitAccepted:
                    retrySearchTransition?.accepted === true,
                  submissionNonce:
                    retrySearchTransition?.submissionNonce || '',
                  onSlowProgress: createDouyinSlowProgressReporter({
                    keyword,
                    current: i + 1,
                    total: keywords.length,
                    stage: 'results_visible_unconfirmed',
                  }),
                },
              ),
            );
            throwConfirmedEmptySearchResult(keyword, retrySearchReadiness);
            if (!retrySearchReadiness.ready) {
              throw new Error(
                `「${keyword}」重新搜索未产生可信的新结果代际，已跳过以免采到旧结果`,
              );
            }
          }
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: keywords.length,
              keyword,
              phase: 'filtering',
              message: `正在切换排序筛选「${keyword}」(${i + 1}/${keywords.length})...`,
            });
          }
          const filterTransition = isDouyinPlatform(platform)
            ? await beginDouyinSearchResultTransitionInTab(
                runnerTabId,
                keyword,
              )
            : null;
          const filterApplication = await applySearchFiltersInTab(
            runnerTabId,
            searchFilters,
            {
            requireVerifiedFilters,
            },
          );
          if (
            isDouyinPlatform(platform) &&
            filterApplication?.complete !== true
          ) {
            throw createSearchFilterApplicationError(filterApplication);
          }
          const filterChanged = Boolean(
            isDouyinPlatform(platform) &&
              filterApplication?.results?.some?.(
                (result) => result?.changed === true,
              ),
          );
          await closeKeywordSearchFilterPanelInTab(runnerTabId);
          if (isDouyinPlatform(platform)) {
            await waitForDouyinSearchPacingWindow(
              runnerTabId,
              shouldStop,
              {phase: 'filter'},
            );
          } else {
            await waitMsWithStop(
              1200,
              shouldStop,
              'BATCH_CAPTURE_CANCELED',
            );
          }
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: keywords.length,
              keyword,
              phase: 'waiting_results',
              message: `正在等待「${keyword}」筛选后的结果加载(${i + 1}/${keywords.length})...`,
            });
          }
          const filteredReadiness = normalizeKeywordSearchReadiness(
            await waitForKeywordSearchResultsInTab(
              runnerTabId,
              platform,
              shouldStop,
              {
                keyword,
                returnState: true,
                requireResultTransition: filterChanged,
                previousWorkIds:
                  filterTransition?.baselineCaptured === true
                    ? filterTransition.previousWorkIds
                    : null,
                submitAccepted:
                  filterChanged &&
                  Boolean(filterTransition?.submissionNonce),
                submissionNonce:
                  filterChanged
                    ? filterTransition?.submissionNonce || ''
                    : '',
                onSlowProgress: createDouyinSlowProgressReporter({
                  keyword,
                  current: i + 1,
                  total: keywords.length,
                  stage: 'filtered_results_visible_unconfirmed',
                }),
              },
            ),
          );
          throwConfirmedEmptySearchResult(keyword, filteredReadiness);
          filteredResultsReady = filteredReadiness.ready;
        }
        if (!filteredResultsReady) {
          throw new Error(
            `「${keyword}」筛选后搜索结果未加载(页面服务异常或筛选后无结果)，已跳过以免采到未筛选内容`,
          );
        }
      }
      await closeKeywordSearchFilterPanelInTab(runnerTabId);

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'capturing',
          message: `正在采集「${keyword}」(${i + 1}/${keywords.length})...`,
        });
      }

      // One keyword owns one child list run; an empty-result retry reuses it,
      // while the next keyword receives a different run id.
      const listCaptureRunId = createCaptureRequestId('list-run');
      const runKeywordCapture = () =>
        captureAndSaveInTab({
          tabId: runnerTabId,
          mode: 'keyword',
          captureParams: {
            ...captureParams,
            keyword,
            listCaptureRunId,
          },
          checkpointSource: 'batch_keyword_capture',
          onProgress: onProgress
            ? (progress = {}) => {
                onProgress({
                  ...progress,
                  current: i + 1,
                  total: keywords.length,
                  keyword,
                  message:
                    progress.message ||
                    `正在采集「${keyword}」(${i + 1}/${keywords.length})...`,
                });
              }
            : null,
        });
      let captureRunResult = await runKeywordCapture();
      let captureResult = captureRunResult?.captureResult || null;
      if (
        isEmptyKeywordCaptureResult(captureResult) &&
        !disableAutomaticSearchRetry
      ) {
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: keywords.length,
            keyword,
            phase: 'waiting_results',
            message: `搜索结果仍在加载，准备重试「${keyword}」(${i + 1}/${keywords.length})...`,
          });
        }
        if (isDouyinPlatform(platform)) {
          douyinSearchTransition = await submitKeywordSearchInTab(
            runnerTabId,
            platform,
            keyword,
            shouldStop,
            {reason: 'empty_list_recovery'},
          );
        }
        const reportRetryWaitProgress = (remainingMs = BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS) => {
          if (!onProgress) {
            return;
          }
          const seconds = Math.ceil(Math.max(0, Number(remainingMs) || 0) / 1000);
          onProgress({
            current: i + 1,
            total: keywords.length,
            keyword,
            phase: 'waiting_results',
            remainingMs,
            message: `搜索结果仍在加载，${seconds} 秒后重试「${keyword}」(${i + 1}/${keywords.length})...`,
          });
        };
        reportRetryWaitProgress();
        await waitMsWithStopAndTick(
          BATCH_KEYWORD_EMPTY_RETRY_WAIT_MS,
          shouldStop,
          {
            errorMessage: 'BATCH_CAPTURE_CANCELED',
            tickMs: 1000,
            onTick: reportRetryWaitProgress,
          },
        );
        const retryReadiness = normalizeKeywordSearchReadiness(
          await waitForKeywordSearchResultsInTab(
            runnerTabId,
            platform,
            shouldStop,
            {
              keyword,
              returnState: true,
              requireResultTransition: isDouyinPlatform(platform),
              previousWorkIds:
                douyinSearchTransition?.baselineCaptured === true
                  ? douyinSearchTransition.previousWorkIds
                  : null,
              submitAccepted:
                douyinSearchTransition?.accepted === true,
              submissionNonce:
                douyinSearchTransition?.submissionNonce || '',
              onSlowProgress: createDouyinSlowProgressReporter({
                keyword,
                current: i + 1,
                total: keywords.length,
                stage: 'results_visible_unconfirmed',
              }),
            },
          ),
        );
        throwConfirmedEmptySearchResult(keyword, retryReadiness);
        const retryResultsReady = retryReadiness.ready;
        if (!retryResultsReady && isDouyinPlatform(platform)) {
          throw new Error(
            `「${keyword}」重试后搜索结果页仍未就绪，已保留后续关键词`,
          );
        }
        // 抖音上面刚重新点了搜索,已挂的筛选会被清空:配置了筛选就必须重挂再采,
        // 否则采到的是未筛选(可能好几年前)的内容。
        if (isDouyinPlatform(platform) && hasActiveBatchSearchFilters(searchFilters)) {
          const refilterTransition =
            await beginDouyinSearchResultTransitionInTab(
              runnerTabId,
              keyword,
            );
          const refilterApplication = await applySearchFiltersInTab(
            runnerTabId,
            searchFilters,
            {requireVerifiedFilters},
          );
          if (refilterApplication?.complete !== true) {
            throw createSearchFilterApplicationError(refilterApplication);
          }
          const refilterChanged = Boolean(
            refilterApplication?.results?.some?.(
              (result) => result?.changed === true,
            ),
          );
          await closeKeywordSearchFilterPanelInTab(runnerTabId);
          await waitForDouyinSearchPacingWindow(
            runnerTabId,
            shouldStop,
            {phase: 'filter'},
          );
          const refilteredReadiness = normalizeKeywordSearchReadiness(
            await waitForKeywordSearchResultsInTab(
              runnerTabId,
              platform,
              shouldStop,
              {
                keyword,
                returnState: true,
                requireResultTransition: refilterChanged,
                previousWorkIds:
                  refilterTransition?.baselineCaptured === true
                    ? refilterTransition.previousWorkIds
                    : null,
                submitAccepted:
                  refilterChanged &&
                  Boolean(refilterTransition?.submissionNonce),
                submissionNonce:
                  refilterChanged
                    ? refilterTransition?.submissionNonce || ''
                    : '',
                onSlowProgress: createDouyinSlowProgressReporter({
                  keyword,
                  current: i + 1,
                  total: keywords.length,
                  stage: 'filtered_results_visible_unconfirmed',
                }),
              },
            ),
          );
          throwConfirmedEmptySearchResult(keyword, refilteredReadiness);
          const refilteredResultsReady = refilteredReadiness.ready;
          if (!refilteredResultsReady) {
            throw new Error(
              `「${keyword}」重挂筛选后搜索结果页仍未就绪，已保留后续关键词`,
            );
          }
        }
        await closeKeywordSearchFilterPanelInTab(runnerTabId);
        captureRunResult = await runKeywordCapture();
        captureResult = captureRunResult?.captureResult || null;
      }

      const captureCanceled = isCaptureCanceledResult(captureResult);
      const captureFatal =
        isExplicitFatalKeywordFailure(captureRunResult) ||
        isExplicitFatalKeywordFailure(captureResult);
      const captureFailure = resolveKeywordFailure(
        captureRunResult,
        captureResult,
      );
      if (captureCanceled && readStopRequested()) {
        canceled = true;
        break;
      }
      if (!captureCanceled && readStopRequested()) {
        canceled = true;
        break;
      }

      if (captureCanceled) {
        const canceledError =
          captureRunResult?.error?.message ||
          captureResult?.error?.message ||
          '当前关键词采集环境临时中断';
        keywordResult = {
          keyword,
          ok: false,
          partial: true,
          fatal: captureFatal || captureFailure.fatal,
          recoverableInterruption: !(captureFatal || captureFailure.fatal),
          error: canceledError,
          errorCode: captureFailure.code,
          errorCategory: captureFailure.category,
          securityBlocked: captureFailure.securityBlocked,
          platformSafetyBlocked: captureFailure.platformSafetyBlocked,
          requiresManualAction: captureFailure.requiresManualAction,
          securityEvidence: captureFailure.securityEvidence,
        };
        results.push(keywordResult);
        failedCount++;
        if (captureFatal || captureFailure.fatal) fatal = true;
      } else if (captureRunResult?.ok) {
        const savedRecords = Array.isArray(captureRunResult.savedRecords)
          ? captureRunResult.savedRecords
          : [];
        const recordIds = Array.isArray(captureRunResult.recordIds)
          ? captureRunResult.recordIds
          : [];
        if (recordIds.length > 0) {
          keywordResult = {
            keyword,
            ok: true,
            recordIds,
            candidateCount: recordIds.length,
            scanComplete: true,
            captureCacheStats: captureRunResult.captureCacheStats || null,
          };
          results.push(keywordResult);
          successCount++;
        } else if (isEmptyKeywordCaptureResult(captureResult)) {
          keywordResult = {
            keyword,
            ok: false,
            error: '搜索结果未加载或未采到可入池记录',
            captureCacheStats: captureRunResult.captureCacheStats || null,
          };
          results.push(keywordResult);
          failedCount++;
        } else {
          keywordResult = {
            keyword,
            ok: false,
            partial: true,
            recordIds: [],
            scanComplete: false,
            errorCode: 'SEARCH_RESULTS_UNCONFIRMED_EMPTY',
            error:
              '搜索流程没有返回可验证的结果，已保留该关键词等待重试',
            captureCacheStats: captureRunResult.captureCacheStats || null,
          };
          results.push(keywordResult);
          failedCount++;
        }
      } else {
        const partialRecordIds = Array.isArray(captureRunResult?.recordIds)
          ? captureRunResult.recordIds
          : [];
        if (partialRecordIds.length > 0) {
          keywordResult = {
            keyword,
            ok: true,
            partial: true,
            scanComplete: false,
            fatal: captureFatal || captureFailure.fatal,
            recordIds: partialRecordIds,
            captureCacheStats: captureRunResult?.captureCacheStats || null,
            warning:
              captureRunResult?.error?.message ||
              captureResult?.error?.message ||
              '采集未完整完成',
            errorCode: captureFailure.code,
            errorCategory: captureFailure.category,
            securityBlocked: captureFailure.securityBlocked,
            platformSafetyBlocked: captureFailure.platformSafetyBlocked,
            requiresManualAction: captureFailure.requiresManualAction,
            securityEvidence: captureFailure.securityEvidence,
          };
          results.push(keywordResult);
          successCount++;
        } else {
          keywordResult = {
            keyword,
            ok: false,
            fatal: captureFatal || captureFailure.fatal,
            error:
              captureRunResult?.error?.message ||
              captureResult?.error?.message ||
              '采集失败',
            errorCode: captureFailure.code,
            errorCategory: captureFailure.category,
            securityBlocked: captureFailure.securityBlocked,
            platformSafetyBlocked: captureFailure.platformSafetyBlocked,
            requiresManualAction: captureFailure.requiresManualAction,
            securityEvidence: captureFailure.securityEvidence,
          };
          results.push(keywordResult);
          failedCount++;
        }
        if (captureFatal || captureFailure.fatal) fatal = true;
      }
    } catch (error) {
      const canceledError = isBatchCaptureCanceledError(error);
      if (canceledError && readStopRequested()) {
        canceled = true;
        break;
      }
      const normalizedKeywordErrorCode = String(error?.code || '')
        .trim()
        .toUpperCase();
      if (
        normalizedKeywordErrorCode === 'CONFIRMED_EMPTY_SEARCH_RESULTS' ||
        normalizedKeywordErrorCode === DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE
      ) {
        const normalizedServiceEmpty =
          normalizedKeywordErrorCode === DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE;
        keywordResult = {
          keyword,
          ok: true,
          noResults: true,
          emptyResult: true,
          resultKind: 'no_matching_results',
          candidateCount: 0,
          scanComplete: true,
          recordIds: [],
          message:
            normalizedServiceEmpty
              ? `「${keyword}」未返回可采搜索结果，已按 0 条正常完成`
              : error?.message ||
                `「${keyword}」在当前筛选范围内没有匹配内容`,
          ...(normalizedServiceEmpty
            ? {normalizedFromErrorCode: DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE}
            : {}),
        };
        results.push(keywordResult);
        successCount++;
        if (onProgress) {
          onProgress({
            current: i + 1,
            total: keywords.length,
            keyword,
            phase: 'no_matching_results',
            message: normalizedServiceEmpty
              ? `「${keyword}」未返回可采搜索结果，已按 0 条正常完成`
              : `「${keyword}」在当前筛选范围内没有匹配内容，已按 0 条正常完成`,
            recordIds: [],
            runnerTabId,
          });
        }
      } else {
      const fatalError = isExplicitFatalKeywordFailure(error);
      const captureFailure = resolveKeywordFailure(error);
      keywordResult = {
        keyword,
        ok: false,
        partial: canceledError,
        recoverableInterruption: canceledError,
        fatal: fatalError || captureFailure.fatal,
        error: error?.message || '当前关键词采集失败',
        errorCode: captureFailure.code,
        errorCategory: captureFailure.category,
        securityBlocked: captureFailure.securityBlocked,
        platformSafetyBlocked: captureFailure.platformSafetyBlocked,
        requiresManualAction: captureFailure.requiresManualAction,
        securityEvidence: captureFailure.securityEvidence,
      };
      results.push(keywordResult);
      failedCount++;
      if (fatalError || captureFailure.fatal) fatal = true;
      }
    } finally {
      // captureAndSaveInTab owns its own checkpoint session.
    }

    if (
      keywordResult?.securityBlocked ||
      isUnattendedSafetyBlock({
        code: keywordResult?.errorCode,
        message: keywordResult?.error || keywordResult?.warning,
        securityBlocked: keywordResult?.securityBlocked,
      })
    ) {
      keywordResult.securityBlocked = true;
      keywordResult.platformSafetyBlocked = Boolean(
        keywordResult.platformSafetyBlocked,
      );
      securityBlocked = true;
      canceled = true;
      if (!blockingError) {
        blockingError = {
          code: String(
            keywordResult.errorCode || 'PLATFORM_SAFETY_BLOCK',
          ).trim(),
          message: String(
            keywordResult.error ||
              keywordResult.warning ||
              '检测到平台异常，已停止任务',
          ).trim(),
          category: String(keywordResult.errorCategory || '').trim(),
          securityBlocked: true,
          platformSafetyBlocked: Boolean(
            keywordResult.platformSafetyBlocked,
          ),
          requiresManualAction: Boolean(
            keywordResult.requiresManualAction,
          ),
          retryable: false,
          ...(keywordResult.securityEvidence?.confirmed === true
            ? {securityEvidence: keywordResult.securityEvidence}
            : {}),
        };
      }
    }

    const keywordRecordIds = Array.isArray(keywordResult?.recordIds)
      ? keywordResult.recordIds.filter(
          (recordId) => typeof recordId === 'string' && recordId.trim(),
        )
      : [];
    const canRunAfterKeywordCapture =
      !canceled &&
      !keywordResult?.fatal &&
      !keywordResult?.noResults &&
      keywordResult?.ok &&
      typeof afterKeywordCapture === 'function';
    if (canRunAfterKeywordCapture && keywordRecordIds.length === 0) {
      keywordResult.enhanceStatus = 'skipped';
      keywordResult.enhanceSkipReason = 'no_record_ids';
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'enhance_skipped',
          message: `关键词「${keyword}」没有采到可入池记录，跳过采集增强`,
          recordIds: [],
          runnerTabId,
        });
      }
    }
    let stopAfterKeyword = Boolean(
      keywordResult?.securityBlocked || keywordResult?.fatal,
    );
    if (canRunAfterKeywordCapture && keywordRecordIds.length > 0) {
      keywordResult.enhanceStatus = 'running';
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'enhancing',
          message: `正在增强关键词「${keyword}」的采集结果(${i + 1}/${keywords.length})...`,
          recordIds: keywordRecordIds,
          runnerTabId,
        });
      }

      try {
        const enhanceResult = await afterKeywordCapture({
          keyword,
          current: i + 1,
          total: keywords.length,
          recordIds: keywordRecordIds,
          result: keywordResult,
          runnerTabId,
        });

        if (enhanceResult !== undefined) {
          keywordResult.enhanceResult = enhanceResult;
        }
        const enhanceSkipReason = String(enhanceResult?.reason || '').trim();
        const unexpectedExplicitSkip =
          Boolean(enhanceResult?.skipped) &&
          keywordRecordIds.length > 0 &&
          ['no_target_records', 'record_ids_unresolved', 'missing_note_url'].includes(
            enhanceSkipReason,
          );
        if (enhanceResult?.skipped) {
          keywordResult.enhanceSkipReason = enhanceSkipReason;
          if (unexpectedExplicitSkip) {
            keywordResult.enhanceStatus = 'failed';
            keywordResult.partial = true;
            keywordResult.warning =
              enhanceResult?.error?.message ||
              `已采到 ${keywordRecordIds.length} 条记录，但采集增强目标未完整解析`;
          } else {
            keywordResult.enhanceStatus = 'skipped';
          }
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: keywords.length,
              keyword,
              phase: unexpectedExplicitSkip
                ? 'enhance_failed'
                : 'enhance_skipped',
              message: unexpectedExplicitSkip
                ? `关键词「${keyword}」采集增强未完整启动：${formatEnhanceSkipReason(enhanceSkipReason)}`
                : `关键词「${keyword}」采集增强已跳过：${formatEnhanceSkipReason(enhanceSkipReason)}`,
              recordIds: keywordRecordIds,
              runnerTabId,
            });
          }
        }
        if (enhanceResult?.securityBlocked) {
          const enhanceFailure = resolveKeywordFailure(enhanceResult);
          keywordResult.enhanceStatus = 'failed';
          keywordResult.securityBlocked = true;
          keywordResult.platformSafetyBlocked =
            enhanceFailure.platformSafetyBlocked;
          keywordResult.requiresManualAction =
            enhanceFailure.requiresManualAction;
          keywordResult.errorCode =
            enhanceFailure.code || keywordResult.errorCode;
          keywordResult.errorCategory =
            enhanceFailure.category || keywordResult.errorCategory;
          keywordResult.securityEvidence =
            enhanceFailure.securityEvidence || keywordResult.securityEvidence;
          keywordResult.warning =
            enhanceFailure.message || keywordResult.warning;
          securityBlocked = true;
          canceled = true;
          stopAfterKeyword = true;
          blockingError = {
            code: enhanceFailure.code || 'PLATFORM_SAFETY_BLOCK',
            message:
              enhanceFailure.message ||
              '检测到平台安全验证，已停止任务',
            category:
              enhanceFailure.category || 'platform_safety_block',
            securityBlocked: true,
            platformSafetyBlocked:
              enhanceFailure.platformSafetyBlocked,
            requiresManualAction:
              enhanceFailure.requiresManualAction,
            retryable: false,
            ...(enhanceFailure.securityEvidence?.confirmed === true
              ? {securityEvidence: enhanceFailure.securityEvidence}
              : {}),
          };
        }
        if (!stopAfterKeyword && isExplicitFatalKeywordFailure(enhanceResult)) {
          keywordResult.enhanceStatus = 'failed';
          keywordResult.partial = true;
          keywordResult.fatal = true;
          keywordResult.warning =
            enhanceResult?.error?.message ||
            keywordResult.warning ||
            '采集增强遇到不可恢复错误';
          fatal = true;
          stopAfterKeyword = true;
        }
        if (
          !stopAfterKeyword &&
          enhanceResult?.canceled
        ) {
          const stopRequested = readStopRequested();
          const recoverableInterruption =
            isRecoverableKeywordInterruption(enhanceResult) || !stopRequested;
          keywordResult.enhanceStatus = 'failed';
          keywordResult.partial = true;
          keywordResult.warning =
            enhanceResult?.error?.message ||
            enhanceResult?.message ||
            keywordResult.warning ||
            '当前关键词采集增强临时中断';
          if (recoverableInterruption) {
            keywordResult.canceled = false;
            keywordResult.recoverableInterruption = true;
            if (stopRequested) {
              // The external environment has already invalidated this run (for
              // example a transient runner/owner loss). Persist the current
              // keyword as partial and let the unattended supervisor resume
              // from the checkpoint instead of misreporting a user cancel.
              keywordResult.recoveryRequired = true;
              recoveryRequired = true;
            }
          } else {
            keywordResult.canceled = true;
            canceled = true;
            stopAfterKeyword = true;
          }
        }
        if (!stopAfterKeyword && enhanceResult && enhanceResult.ok === false) {
          keywordResult.enhanceStatus = 'failed';
          keywordResult.partial = true;
          keywordResult.warning =
            enhanceResult?.error?.message || keywordResult.warning || '采集增强未完整完成';
        } else if (!stopAfterKeyword && !enhanceResult?.skipped) {
          keywordResult.enhanceStatus = 'done';
        }
      } catch (error) {
        const canceledError = isBatchCaptureCanceledError(error);
        if (canceledError && readStopRequested()) {
          keywordResult.enhanceStatus = 'failed';
          keywordResult.canceled = true;
          canceled = true;
          stopAfterKeyword = true;
        } else {
          keywordResult.enhanceStatus = 'failed';
          keywordResult.partial = true;
          keywordResult.warning =
            error?.message || keywordResult.warning || '采集增强失败';
          if (canceledError) {
            keywordResult.canceled = false;
            keywordResult.recoverableInterruption = true;
          }
          if (isUnattendedSafetyBlock(error)) {
            const enhanceFailure = resolveKeywordFailure(error);
            keywordResult.securityBlocked = true;
            keywordResult.platformSafetyBlocked =
              enhanceFailure.platformSafetyBlocked;
            keywordResult.requiresManualAction =
              enhanceFailure.requiresManualAction;
            keywordResult.errorCode =
              enhanceFailure.code || keywordResult.errorCode;
            keywordResult.errorCategory =
              enhanceFailure.category || keywordResult.errorCategory;
            keywordResult.securityEvidence =
              enhanceFailure.securityEvidence || keywordResult.securityEvidence;
            securityBlocked = true;
            canceled = true;
            stopAfterKeyword = true;
            blockingError = {
              code: enhanceFailure.code || 'PLATFORM_SAFETY_BLOCK',
              message:
                enhanceFailure.message ||
                keywordResult.warning ||
                '检测到平台安全验证，已停止任务',
              category:
                enhanceFailure.category || 'platform_safety_block',
              securityBlocked: true,
              platformSafetyBlocked:
                enhanceFailure.platformSafetyBlocked,
              requiresManualAction:
                enhanceFailure.requiresManualAction,
              retryable: false,
              ...(enhanceFailure.securityEvidence?.confirmed === true
                ? {securityEvidence: enhanceFailure.securityEvidence}
                : {}),
            };
          } else if (isExplicitFatalKeywordFailure(error)) {
            keywordResult.fatal = true;
            fatal = true;
            stopAfterKeyword = true;
          }
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: keywords.length,
              keyword,
              phase: 'enhance_failed',
              message: `关键词「${keyword}」采集增强失败：${keywordResult.warning}`,
              recordIds: keywordRecordIds,
              runnerTabId,
            });
          }
        }
      }
    }

    if (keywordResult && typeof onKeywordSettled === 'function') {
      await onKeywordSettled({
        current: i + 1,
        total: keywords.length,
        keyword,
        result: keywordResult,
        recordIds: keywordRecordIds,
        runnerTabId,
        securityBlocked: Boolean(keywordResult.securityBlocked),
        canceled: Boolean(keywordResult.canceled),
      });
    }

    if (stopAfterKeyword || recoveryRequired) {
      break;
    }

    // 关键词间随机延迟:分钟级(防风控,见常量注释)。最后一个不延迟。
    if (i < keywords.length - 1) {
      const delay =
        BATCH_INTER_KEYWORD_DELAY_MIN_MS +
        Math.random() *
          (BATCH_INTER_KEYWORD_DELAY_MAX_MS - BATCH_INTER_KEYWORD_DELAY_MIN_MS);
      await activateTabForReliableTimer(waitForegroundTabId);
      const reportDelayProgress = async (remainingMs = delay) => {
        if (isDouyinPlatform(platform)) {
          await assertNoDouyinSearchSecurityChallengeInTab(runnerTabId);
        }
        if (!onProgress) {
          return;
        }
        onProgress({
          current: i + 1,
          total: keywords.length,
          keyword,
          phase: 'inter_keyword_delay',
          remainingMs,
          runnerTabId,
          message: buildInterKeywordDelayMessage({
            keyword,
            delay: remainingMs,
            hasEnhanceStep: typeof afterKeywordCapture === 'function',
            keywordResult,
          }),
        });
      };
      try {
        await reportDelayProgress(delay);
        await waitMsWithStopAndTick(delay, shouldStop, {
          errorMessage: 'BATCH_CAPTURE_CANCELED',
          tickMs: 1000,
          onTick: reportDelayProgress,
        });
      } catch (error) {
        if (isDouyinSearchSecurityChallengeError(error)) {
          securityBlocked = true;
          canceled = true;
          blockingError = {
            code: String(
              error?.code || DOUYIN_SEARCH_SECURITY_CHALLENGE_CODE,
            ).trim(),
            message: String(
              error?.message ||
                '检测到抖音图片安全验证，已停止后续搜索',
            ).trim(),
            category: String(
              error?.category || 'platform_safety_block',
            ).trim(),
            securityBlocked: true,
            platformSafetyBlocked: true,
            requiresManualAction: true,
            retryable: false,
          };
          if (onProgress) {
            onProgress({
              current: i + 1,
              total: keywords.length,
              keyword,
              phase: 'needs_action',
              runnerTabId,
              securityBlocked: true,
              platformSafetyBlocked: true,
              requiresManualAction: true,
              error: blockingError,
              message: blockingError.message,
            });
          }
          break;
        }
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  if (onProgress) {
    const terminalNeedsAction = Boolean(securityBlocked);
    onProgress({
      current: successCount + failedCount,
      total: keywords.length,
      keyword: '',
      phase: terminalNeedsAction
        ? 'needs_action'
        : canceled
          ? 'canceled'
          : 'done',
      securityBlocked: terminalNeedsAction,
      platformSafetyBlocked: Boolean(
        blockingError?.platformSafetyBlocked,
      ),
      requiresManualAction: Boolean(
        terminalNeedsAction || blockingError?.requiresManualAction,
      ),
      error: terminalNeedsAction ? blockingError : null,
      message: terminalNeedsAction
        ? blockingError?.message ||
          `检测到平台异常，已停止整批任务：已处理 ${successCount + failedCount}/${keywords.length}`
        : canceled
          ? `批量采集已停止：已处理 ${successCount + failedCount}/${keywords.length}，成功 ${successCount}，失败 ${failedCount}`
        : `批量采集完成：成功 ${successCount}，失败 ${failedCount}`,
    });
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    securityBlocked,
    platformSafetyBlocked: Boolean(blockingError?.platformSafetyBlocked),
    requiresManualAction: Boolean(
      securityBlocked || blockingError?.requiresManualAction,
    ),
    blockingError,
    fatal,
    recoveryRequired,
    results,
    stats: {
      total: keywords.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
    },
  };
  } finally {
    if (typeof runnerReplacementEvents?.removeListener === 'function') {
      runnerReplacementEvents.removeListener(handleRunnerTabReplacement);
    }
    // 检查点持久化或外部回调失败时也必须恢复 runner 原页，避免页面永久停在半途关键词。
    if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
      try {
        const currentTab = await chrome.tabs.get(runnerTabId);
        const currentUrl = normalizeUrlWithoutHash(currentTab?.url);
        const sourceUrl = normalizeUrlWithoutHash(runnerCtx.sourcePageUrl);
        if (currentUrl !== sourceUrl) {
          await chrome.tabs.update(runnerTabId, {
            url: runnerCtx.sourcePageUrl,
          });
        }
      } catch {
        // ignore restore failure
      }
    }
  }
}

export async function lightSampleByKeywords({
  categorySamples = [],
  platform = '',
  baseSearchUrl = '',
  onProgress = null,
  shouldStop = null,
} = {}) {
  if (!Array.isArray(categorySamples) || categorySamples.length === 0) {
    return {
      ok: true,
      canceled: false,
      results: {},
      stats: { total: 0, success: 0, failed: 0 },
    };
  }

  const sourceTab = await getCurrentActiveTab();
  const runnerCtx = await prepareDetailBatchRunnerContext({ sourceTab });
  const { runnerTabId } = runnerCtx;

  const results = {};
  let successCount = 0;
  let failedCount = 0;
  let canceled = false;

  for (let i = 0; i < categorySamples.length; i++) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      canceled = true;
      break;
    }

    const item = categorySamples[i] && typeof categorySamples[i] === 'object'
      ? categorySamples[i]
      : {};
    const categoryId = String(item.categoryId || '').trim();
    const candidateKeywords = Array.isArray(item.candidateKeywords)
      ? item.candidateKeywords
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean)
      : [];

    if (!categoryId || candidateKeywords.length === 0) {
      failedCount++;
      continue;
    }

    let categoryResult = {
      categoryId,
      usedKeyword: null,
      status: 'error',
      errorMessage: '未找到可用采样关键词',
      samples: [],
    };

    for (let j = 0; j < candidateKeywords.length; j++) {
      if (typeof shouldStop === 'function' && shouldStop()) {
        canceled = true;
        break;
      }

      const keyword = candidateKeywords[j];
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: categorySamples.length,
          categoryId,
          keyword,
          phase: 'sampling',
          message: `正在采样方向词「${keyword}」(${i + 1}/${categorySamples.length})...`,
        });
      }

      try {
        const searchUrl = buildKeywordSearchUrl(keyword, platform, baseSearchUrl);
        await navigateToSearchUrl(runnerTabId, searchUrl, shouldStop);
        await waitMsWithStop(
          BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
          shouldStop,
          'BATCH_CAPTURE_CANCELED',
        );

        const captureResult = await captureInTab(runnerTabId, {
          mode: 'keyword',
          captureParams: {
            keyword,
            minLikes: 0,
            maxDetectedItems: 3,
            maxScrollTimes: 3,
            waitMinMs: 800,
            waitMaxMs: 1500,
            stallTimeoutMs: 2000,
            maxDurationMs: 20_000,
          },
        });

        if (isCaptureCanceledResult(captureResult)) {
          canceled = true;
          break;
        }

        const payload =
          captureResult?.data && typeof captureResult.data === 'object'
            ? captureResult.data
            : null;
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (items.length === 0) {
          categoryResult = {
            categoryId,
            usedKeyword: keyword,
            status: 'error',
            errorMessage: '未获取到样本数据',
            samples: [],
          };
          continue;
        }

        categoryResult = {
          categoryId,
          usedKeyword: keyword,
          status: 'success',
          errorMessage: '',
          samples: items.slice(0, 3).map((sample) => ({
            title: String(sample?.title || '').trim(),
            author: String(sample?.author || '').trim(),
            likes: Number(sample?.likes) || 0,
            comments: Number(sample?.comments) || 0,
            coverImageUrl: String(sample?.coverImageUrl || '').trim(),
            url: String(sample?.url || '').trim(),
          })),
        };
        break;
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        categoryResult = {
          categoryId,
          usedKeyword: keyword,
          status: 'error',
          errorMessage: error?.message || '轻采样失败',
          samples: [],
        };
      }
    }

    if (canceled) {
      break;
    }

    results[categoryId] = categoryResult;
    if (categoryResult.status === 'success') {
      successCount++;
    } else {
      failedCount++;
    }

    if (onProgress) {
      onProgress({
        current: i + 1,
        total: categorySamples.length,
        categoryId,
        keyword: categoryResult.usedKeyword || '',
        phase: 'category_done',
        message:
          categoryResult.status === 'success'
            ? `方向样本已更新（${i + 1}/${categorySamples.length}）`
            : `方向样本获取失败（${i + 1}/${categorySamples.length}）`,
        result: categoryResult,
      });
    }

    if (i < categorySamples.length - 1) {
      const delay =
        BATCH_KEYWORD_DELAY_MIN_MS +
        Math.random() * (BATCH_KEYWORD_DELAY_MAX_MS - BATCH_KEYWORD_DELAY_MIN_MS);
      try {
        await waitMsWithStop(delay, shouldStop, 'BATCH_CAPTURE_CANCELED');
      } catch (error) {
        if (isBatchCaptureCanceledError(error)) {
          canceled = true;
          break;
        }
        throw error;
      }
    }
  }

  if (runnerCtx.shouldRestoreSourcePage && runnerCtx.sourcePageUrl) {
    try {
      await chrome.tabs.update(runnerTabId, { url: runnerCtx.sourcePageUrl });
    } catch {
      // ignore restore failure
    }
  }

  return {
    ok: !canceled && failedCount === 0,
    canceled,
    results,
    stats: {
      total: categorySamples.length,
      processed: successCount + failedCount,
      success: successCount,
      failed: failedCount,
    },
  };
}

export async function captureTabContent(
  tabId,
  {
    mode = 'auto',
    captureParams = {},
  } = {},
) {
  return captureInTab(tabId, {
    mode,
    captureParams,
  });
}

/**
 * 根据平台构建关键词搜索 URL
 */
function buildKeywordSearchUrl(keyword, platform, baseSearchUrl) {
  const encodedKeyword = encodeURIComponent(keyword);

  if (platform === 'douyin') {
    return `https://www.douyin.com/search/${encodedKeyword}?type=general`;
  }

  if (platform === 'weibo') {
    return `https://s.weibo.com/weibo?q=${encodedKeyword}`;
  }

  // 小红书：统一构造到搜索结果路由，避免把关键词拼到 explore/discovery 等无效路径上
  const xhsDefaultSearchUrl = new URL('https://www.xiaohongshu.com/search_result');
  xhsDefaultSearchUrl.searchParams.set('source', 'web_explore_feed');
  xhsDefaultSearchUrl.searchParams.set('type', '51');

  if (baseSearchUrl) {
    try {
      const parsed = new URL(baseSearchUrl);
      const pathname = String(parsed.pathname || '').toLowerCase();
      const isXhsSearchPath =
        pathname.includes('/search_result') ||
        pathname.includes('/web/search_result') ||
        pathname.includes('/search/result');

      // 已在搜索结果页：复用该 URL 的搜索参数，避免丢失可用上下文
      if (isXhsSearchPath) {
        parsed.searchParams.set('keyword', keyword);
        return parsed.toString();
      }

      // 非搜索结果页（例如 explore）：切到标准搜索路由，只拷贝与搜索相关的参数
      const nextSearchUrl = new URL(xhsDefaultSearchUrl.toString());
      const source = String(parsed.searchParams.get('source') || '').trim();
      const type = String(parsed.searchParams.get('type') || '').trim();
      if (source) {
        nextSearchUrl.searchParams.set('source', source);
      }
      if (type) {
        nextSearchUrl.searchParams.set('type', type);
      }
      nextSearchUrl.searchParams.set('keyword', keyword);
      return nextSearchUrl.toString();
    } catch {
      // fallback
    }
  }

  xhsDefaultSearchUrl.searchParams.set('keyword', keyword);
  return xhsDefaultSearchUrl.toString();
}

function isDouyinPlatform(platform = '') {
  return String(platform || '').trim().toLowerCase() === 'douyin';
}

async function submitKeywordSearchInTab(
  tabId,
  platform = '',
  keyword = '',
  shouldStop = null,
  {reason = ''} = {},
) {
  if (!isDouyinPlatform(platform)) {
    return false;
  }
  const normalizedReason = String(reason || '').trim().toLowerCase();
  const allowedReasons = new Set([
    'initial_search_generation',
    'filter_generation_recovery',
    'empty_list_recovery',
  ]);
  // 整词提交会重置筛选并触发平台搜索。没有明确、受控 reason 时禁止点击，
  // 避免慢进展探测退化成无条件重复搜索。
  if (!allowedReasons.has(normalizedReason)) {
    return false;
  }
  if (typeof shouldStop === 'function' && shouldStop()) {
    throw new Error('BATCH_CAPTURE_CANCELED');
  }
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }
  await assertNoDouyinSearchSecurityChallengeInTab(normalizedTabId);

  const guardResponse = await chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: normalizedTabId,
      payload: {action: 'assertNoDouyinSearchServiceAbnormal'},
    })
    .catch(() => null);
  const guardContentResponse = guardResponse?.data;
  const guardError =
    guardResponse?.ok === false
      ? guardResponse?.error
      : guardContentResponse?.ok === false
        ? guardContentResponse?.error
        : null;
  if (isDouyinSearchServiceAbnormalError(guardError)) {
    throw createDouyinSearchServiceAbnormalError({
      message: guardError?.message,
    });
  }
  if (isDouyinSearchSecurityChallengeError(guardError)) {
    throw createDouyinSearchSecurityChallengeError({
      message: guardError?.message,
    });
  }

  // Every click owns the exact visible result baseline that immediately
  // preceded it. Resubmits must never reuse the first navigation baseline,
  // otherwise a no-op click can be mistaken for a later result generation.
  const previousResults = await readDouyinSearchWorkIdsInTab(normalizedTabId);

  const result = await chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: (expectedKeyword) => {
        const normalize = (value) =>
          String(value || '').trim().toLowerCase().replace(/\s+/g, '');
        const decode = (value) => {
          try {
            return decodeURIComponent(String(value || ''));
          } catch {
            return String(value || '');
          }
        };
        const expected = normalize(expectedKeyword);
        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return (
            rect.width > 4 &&
            rect.height > 4 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.01
          );
        };
        const getInputValue = (node) => {
          if (!node) {
            return '';
          }
          return String(node.value || node.textContent || '').trim();
        };
        const input =
          Array.from(
            document.querySelectorAll(
              '[data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"], textarea, [contenteditable="true"]',
            ),
          ).find(isVisible) || null;
        const currentUrl = new URL(window.location.href);
        const urlKeyword = decode(
          currentUrl.pathname.split('/search/')[1]?.split('/')[0] || '',
        );
        const inputKeyword = getInputValue(input);
        const keywordMatched =
          !expected ||
          normalize(urlKeyword) === expected ||
          normalize(inputKeyword) === expected;
        if (!keywordMatched) {
          return {
            clicked: false,
            reason: 'keyword_not_matched',
            urlKeyword,
            inputKeyword,
          };
        }

        const installSubmissionWitness = () => {
          const witnessKey = '__STARVOICE_DOUYIN_SEARCH_WITNESS__';
          const resultRootSelector = [
            '#search-result-container',
            '#waterFallScrollContainer',
            '[data-e2e="scroll-list"]',
          ].join(',');
          const resultIdentitySelector = [
            '[id^="waterfall_item_"]',
            '[data-e2e-aweme-id]',
            '[data-aweme-id]',
            '[data-awemeid]',
            '[data-modal-id]',
            'a[href*="/video/"]',
            'a[href*="/note/"]',
            'a[href*="modal_id="]',
          ].join(',');
          const readRoot = () => document.querySelector(resultRootSelector);
          const countResults = (root) =>
            root?.querySelectorAll?.(resultIdentitySelector)?.length || 0;
          const baselineRoot = readRoot();
          const baselineCount = countResults(baselineRoot);
          const baselineBusy =
            String(baselineRoot?.getAttribute?.('aria-busy') || '')
              .toLowerCase() === 'true';
          const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const witness = {
            nonce,
            keyword: expected,
            submittedAt: Date.now(),
            baselineCount,
            mutationCount: 0,
            baselineBusy,
            sawBusyStart: false,
            sawBusyRoundTrip: false,
            sawCleared: false,
            sawClearRepopulated: false,
            rootReplaced: false,
            generationChanged: false,
            observer: null,
          };
          try {
            window[witnessKey]?.observer?.disconnect?.();
          } catch {
            // A stale page-owned marker must not block the new submission.
          }
          window[witnessKey] = witness;
          if (
            typeof MutationObserver !== 'function' ||
            !document.body
          ) {
            return nonce;
          }
          const isRelatedNode = (node, root) => {
            if (!node || !root) return false;
            if (node === root) return true;
            try {
              return Boolean(root.contains?.(node) || node.contains?.(root));
            } catch {
              return false;
            }
          };
          const observer = new MutationObserver((records) => {
            const currentRoot = readRoot();
            const relevantRecords = Array.from(records || []).filter((record) => {
              if (isRelatedNode(record?.target, baselineRoot) ||
                  isRelatedNode(record?.target, currentRoot)) {
                return true;
              }
              return Array.from(record?.addedNodes || [])
                .concat(Array.from(record?.removedNodes || []))
                .some((node) =>
                  isRelatedNode(node, baselineRoot) ||
                  isRelatedNode(node, currentRoot) ||
                  node?.matches?.(resultRootSelector) ||
                  node?.querySelector?.(resultRootSelector),
                );
            });
            if (relevantRecords.length === 0) return;
            witness.mutationCount += relevantRecords.length;
            if (
              baselineRoot &&
              currentRoot &&
              currentRoot !== baselineRoot
            ) {
              witness.rootReplaced = true;
            }
            const currentCount = countResults(currentRoot);
            if (baselineCount > 0 && currentCount === 0) {
              witness.sawCleared = true;
            }
            const busy =
              String(currentRoot?.getAttribute?.('aria-busy') || '')
                .toLowerCase() === 'true';
            if (!witness.baselineBusy && busy) {
              witness.sawBusyStart = true;
            }
            if (witness.sawBusyStart && !busy) {
              witness.sawBusyRoundTrip = true;
            }
            if (witness.sawCleared && currentCount > 0) {
              witness.sawClearRepopulated = true;
            }
            witness.generationChanged ||= Boolean(
              witness.rootReplaced ||
                witness.sawBusyRoundTrip ||
                witness.sawClearRepopulated ||
                (witness.sawCleared && currentCount === 0),
            );
          });
          witness.observer = observer;
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['aria-busy'],
          });
          if (typeof setTimeout === 'function') {
            setTimeout(() => observer.disconnect(), 90_000);
          }
          return nonce;
        };

        const buttonSelectors = [
          '[data-e2e="searchbar-button"]',
          'button[type="submit"]',
          '[role="button"][aria-label*="搜索"]',
          'button[aria-label*="搜索"]',
        ];
        const selectorButton = buttonSelectors
          .map((selector) => document.querySelector(selector))
          .find(isVisible);
        const textButton =
          selectorButton ||
          Array.from(document.querySelectorAll('button, [role="button"], a'))
            .filter(isVisible)
            .find((node) => normalize(node.textContent) === normalize('搜索'));
        const button = textButton;
        if (!button) {
          if (input) {
            const submissionNonce = installSubmissionWitness();
            input.focus?.();
            input.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
              }),
            );
            input.dispatchEvent(
              new KeyboardEvent('keyup', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
                cancelable: true,
              }),
            );
            return {clicked: true, via: 'enter', submissionNonce};
          }
          return {clicked: false, reason: 'button_not_found'};
        }

        const submissionNonce = installSubmissionWitness();
        button.scrollIntoView?.({block: 'center', inline: 'center'});
        button.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            button: 0,
          }),
        );
        button.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        button.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            button: 0,
          }),
        );
        button.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        button.click?.();
        return {clicked: true, via: 'button', submissionNonce};
      },
      args: [keyword],
    })
    .then(([scriptResult]) => scriptResult?.result || null)
    .catch(() => null);

  if (result?.clicked !== true) return false;
  return Object.freeze({
    accepted: true,
    via: String(result?.via || ''),
    reason: normalizedReason,
    submissionNonce: String(result?.submissionNonce || ''),
    baselineCaptured: previousResults.captured === true,
    previousWorkIds: previousResults.workIds,
  });
}

async function readDouyinSearchWorkIdsInTab(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return {captured: false, workIds: []};
  }
  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: () => {
        const resultRoots = [
          '#search-result-container',
          '#waterFallScrollContainer',
          '[data-e2e="scroll-list"]',
        ];
        const identitySelectors = [
          '[id^="waterfall_item_"]',
          '[data-e2e-aweme-id]',
          '[data-aweme-id]',
          '[data-awemeid]',
          '[data-modal-id]',
          'a[href*="/video/"]',
          'a[href*="/note/"]',
          'a[href*="modal_id="]',
          'a[data-href*="/video/"]',
          'a[data-href*="/note/"]',
          'a[data-url*="/video/"]',
          'a[data-url*="/note/"]',
        ];
        const selectors = resultRoots.flatMap((root) =>
          identitySelectors.map((identity) => `${root} ${identity}`),
        );
        const decode = (value) => {
          try {
            return decodeURIComponent(String(value || ''));
          } catch {
            return String(value || '');
          }
        };
        const extractFromUrl = (value) => {
          const candidates = [String(value || ''), decode(value)];
          for (const candidate of candidates) {
            const matched = candidate.match(
              /\/(?:video|note)\/(\d{8,})(?:[/?#]|$)|[?&]modal_id=(\d{8,})(?:[&#]|$)/iu,
            );
            if (matched?.[1] || matched?.[2]) return matched[1] || matched[2];
          }
          return '';
        };
        const isVisible = (node) => {
          if (!(node instanceof Element)) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 8 || rect.height <= 8) return false;
          const style = window.getComputedStyle(node);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0.01;
        };
        const workIds = [];
        const seen = new Set();
        const nodes = Array.from(document.querySelectorAll(selectors.join(',')))
          .slice(0, 200);
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const waterfallId = String(node.id || '').match(
            /^waterfall_item_(\d{8,})(?:$|[_:-])/u,
          )?.[1];
          const dedicatedId = [
            node.getAttribute?.('data-e2e-aweme-id'),
            node.getAttribute?.('data-aweme-id'),
            node.getAttribute?.('data-awemeid'),
            node.getAttribute?.('data-modal-id'),
          ].map((value) => String(value || '').trim())
            .find((value) => /^\d{8,}$/u.test(value));
          const linkedId = [
            node.getAttribute?.('href'),
            node.getAttribute?.('data-href'),
            node.getAttribute?.('data-url'),
          ].map(extractFromUrl).find(Boolean);
          const workId = waterfallId || dedicatedId || linkedId || '';
          if (!/^\d{8,}$/u.test(workId) || seen.has(workId)) continue;
          seen.add(workId);
          workIds.push(workId);
        }
        return {captured: true, workIds};
      },
    })
    .then(([result]) => {
      const value = result?.result;
      return {
        captured: value?.captured === true,
        workIds: Array.from(
          new Set(
            (Array.isArray(value?.workIds) ? value.workIds : [])
              .map((workId) => String(workId || '').trim())
              .filter((workId) => /^\d{8,}$/u.test(workId)),
          ),
        ),
      };
    })
    .catch(() => ({captured: false, workIds: []}));
}

export async function beginDouyinSearchResultTransitionInTab(
  tabId,
  keyword = '',
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return Object.freeze({
      baselineCaptured: false,
      previousWorkIds: [],
      submissionNonce: '',
    });
  }
  const previousResults = await readDouyinSearchWorkIdsInTab(normalizedTabId);
  const submissionNonce = await chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: (expectedKeyword) => {
        const witnessKey = '__STARVOICE_DOUYIN_SEARCH_WITNESS__';
        const resultRootSelector = [
          '#search-result-container',
          '#waterFallScrollContainer',
          '[data-e2e="scroll-list"]',
        ].join(',');
        const resultIdentitySelector = [
          '[id^="waterfall_item_"]',
          '[data-e2e-aweme-id]',
          '[data-aweme-id]',
          '[data-awemeid]',
          '[data-modal-id]',
          'a[href*="/video/"]',
          'a[href*="/note/"]',
          'a[href*="modal_id="]',
        ].join(',');
        const readRoot = () => document.querySelector(resultRootSelector);
        const countResults = (root) =>
          root?.querySelectorAll?.(resultIdentitySelector)?.length || 0;
        const baselineRoot = readRoot();
        const baselineCount = countResults(baselineRoot);
        const baselineBusy =
          String(baselineRoot?.getAttribute?.('aria-busy') || '')
            .toLowerCase() === 'true';
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const witness = {
          nonce,
          keyword: String(expectedKeyword || '').trim(),
          submittedAt: Date.now(),
          baselineCount,
          baselineBusy,
          mutationCount: 0,
          sawBusyStart: false,
          sawBusyRoundTrip: false,
          sawCleared: false,
          sawClearRepopulated: false,
          rootReplaced: false,
          generationChanged: false,
          observer: null,
        };
        try {
          window[witnessKey]?.observer?.disconnect?.();
        } catch {
          // A stale page-owned marker cannot block the next exact operation.
        }
        window[witnessKey] = witness;
        if (typeof MutationObserver !== 'function' || !document.body) {
          return nonce;
        }
        const isRelatedNode = (node, root) => {
          if (!node || !root) return false;
          if (node === root) return true;
          try {
            return Boolean(root.contains?.(node) || node.contains?.(root));
          } catch {
            return false;
          }
        };
        const observer = new MutationObserver((records) => {
          const currentRoot = readRoot();
          const relevantRecords = Array.from(records || []).filter((record) => {
            if (
              isRelatedNode(record?.target, baselineRoot) ||
              isRelatedNode(record?.target, currentRoot)
            ) {
              return true;
            }
            return Array.from(record?.addedNodes || [])
              .concat(Array.from(record?.removedNodes || []))
              .some((node) =>
                isRelatedNode(node, baselineRoot) ||
                isRelatedNode(node, currentRoot) ||
                node?.matches?.(resultRootSelector) ||
                node?.querySelector?.(resultRootSelector),
              );
          });
          if (relevantRecords.length === 0) return;
          witness.mutationCount += relevantRecords.length;
          if (
            baselineRoot &&
            currentRoot &&
            currentRoot !== baselineRoot
          ) {
            witness.rootReplaced = true;
          }
          const currentCount = countResults(currentRoot);
          if (baselineCount > 0 && currentCount === 0) {
            witness.sawCleared = true;
          }
          const busy =
            String(currentRoot?.getAttribute?.('aria-busy') || '')
              .toLowerCase() === 'true';
          if (!witness.baselineBusy && busy) {
            witness.sawBusyStart = true;
          }
          if (witness.sawBusyStart && !busy) {
            witness.sawBusyRoundTrip = true;
          }
          if (witness.sawCleared && currentCount > 0) {
            witness.sawClearRepopulated = true;
          }
          witness.generationChanged ||= Boolean(
            witness.rootReplaced ||
              witness.sawBusyRoundTrip ||
              witness.sawClearRepopulated ||
              (witness.sawCleared && currentCount === 0),
          );
        });
        witness.observer = observer;
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-busy'],
        });
        if (typeof setTimeout === 'function') {
          setTimeout(() => observer.disconnect(), 90_000);
        }
        return nonce;
      },
      args: [keyword],
    })
    .then(([result]) => String(result?.result || ''))
    .catch(() => '');
  return Object.freeze({
    baselineCaptured: previousResults.captured === true,
    previousWorkIds: previousResults.workIds,
    submissionNonce,
  });
}

export async function readDouyinSearchDocumentGenerationInTab(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return null;
  }
  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: () => ({
        timeOrigin: Number(globalThis.performance?.timeOrigin) || 0,
        readyState: String(document.readyState || ''),
        pageUrl: String(window.location.href || ''),
      }),
    })
    .then(([result]) => {
      const value = result?.result;
      return Number(value?.timeOrigin) > 0
        ? {
            timeOrigin: Number(value.timeOrigin),
            readyState: String(value.readyState || ''),
            pageUrl: String(value.pageUrl || ''),
          }
        : null;
    })
    .catch(() => null);
}

async function waitForFreshDouyinSearchDocumentInTab(
  tabId,
  navigationContext,
  previousGeneration,
  shouldStop = null,
  timeoutMs = 6000,
) {
  const previousTimeOrigin = Number(previousGeneration?.timeOrigin) || 0;
  if (previousTimeOrigin <= 0) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < Math.max(0, Number(timeoutMs) || 0)) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }
    const [tab, generation] = await Promise.all([
      chrome.tabs.get(tabId).catch(() => null),
      readDouyinSearchDocumentGenerationInTab(tabId),
    ]);
    if (
      isKeywordSearchTabUrlReady(tab?.url || '', navigationContext) &&
      generation?.readyState === 'complete' &&
      Number(generation.timeOrigin) > 0 &&
      Number(generation.timeOrigin) !== previousTimeOrigin
    ) {
      return true;
    }
    await waitMs(BATCH_KEYWORD_NAV_POLL_MS);
  }
  return false;
}

async function switchDouyinKeywordSearchInTab(
  tabId,
  keyword = '',
  targetUrl = '',
  shouldStop = null,
) {
  const navigationContext = parseKeywordSearchNavigationContext(targetUrl);
  if (typeof shouldStop === 'function' && shouldStop()) {
    throw new Error('BATCH_CAPTURE_CANCELED');
  }

  let navigationTransitionAccepted = false;
  if (!(await isKeywordSearchTargetReadyInTab(tabId, navigationContext))) {
    const previousDocumentGeneration =
      await readDouyinSearchDocumentGenerationInTab(tabId);
    await chrome.tabs.update(tabId, {
      url: targetUrl,
      active: true,
    });
    const ready = await waitForKeywordSearchTargetReadyInTab(
      tabId,
      navigationContext,
      shouldStop,
      6000,
    );
    // 抖音可能把搜索 URL 重写为无关键词的 /jingxuan/search。目标词字面未确认时
    // 仍允许继续提交，但后续结果必须证明作品集合相对提交前发生了替换；不能只凭旧卡片稳定放行。
    if (ready) {
      navigationTransitionAccepted =
        await waitForFreshDouyinSearchDocumentInTab(
          tabId,
          navigationContext,
          previousDocumentGeneration,
          shouldStop,
          6000,
        );
    }
    if (!navigationTransitionAccepted && !ready) {
      await waitMsWithStop(
        BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
        shouldStop,
        'BATCH_CAPTURE_CANCELED',
      );
    } else if (!navigationTransitionAccepted) {
      const navigatedTab = await chrome.tabs.get(tabId).catch(() => null);
      const exactNavigationTargetReady = isKeywordSearchTabUrlReady(
        navigatedTab?.url || '',
        navigationContext,
      );
      if (!exactNavigationTargetReady) {
        await waitMsWithStop(
          BATCH_KEYWORD_AFTER_NAV_WAIT_MS,
          shouldStop,
          'BATCH_CAPTURE_CANCELED',
        );
      }
    }
  }

  // URL text alone is not navigation proof: a slow SPA can expose the new URL
  // while the previous keyword cards remain mounted. Only a different
  // performance.timeOrigin plus document.readyState=complete may bypass the
  // click witness. Same-document navigation falls back to a fresh baseline
  // and the strong result lifecycle below.
  if (navigationTransitionAccepted) {
    return Object.freeze({
      baselineCaptured: false,
      previousWorkIds: [],
      submitAccepted: false,
      submissionNonce: '',
      navigationTransitionAccepted: true,
    });
  }

  const submission = await submitKeywordSearchInTab(
    tabId,
    'douyin',
    keyword,
    shouldStop,
    {reason: 'initial_search_generation'},
  );
  return Object.freeze({
    baselineCaptured: submission?.baselineCaptured === true,
    previousWorkIds: Array.isArray(submission?.previousWorkIds)
      ? submission.previousWorkIds
      : [],
    submitAccepted:
      submission === true || submission?.accepted === true,
    submissionNonce: String(submission?.submissionNonce || ''),
    navigationTransitionAccepted: false,
  });
}

/**
 * 导航到搜索 URL 并等待页面加载完成
 */
async function navigateToSearchUrl(tabId, targetUrl, shouldStop) {
  await chrome.tabs.update(tabId, {
    url: targetUrl,
    active: true,
  });

  const navigationContext = parseKeywordSearchNavigationContext(targetUrl);
  const startedAt = Date.now();
  let reachedComplete = false;
  while (Date.now() - startedAt < BATCH_KEYWORD_NAV_TIMEOUT_MS) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(error?.message || '读取标签页状态失败');
    }

    const tabComplete = String(tab?.status || '') === 'complete';
    if (tabComplete) {
      reachedComplete = true;
    }

    if (
      tabComplete &&
      isKeywordSearchTabUrlReady(tab?.url || '', navigationContext)
    ) {
      return;
    }

    if (
      navigationContext.platform === 'douyin' &&
      await isKeywordSearchTargetReadyInTab(tabId, navigationContext)
    ) {
      return;
    }

    if (
      await isKeywordSearchDomReadyInTab(tabId, {
        platform: navigationContext.platform,
        keyword: navigationContext.keyword,
      })
    ) {
      return;
    }

    await waitMs(BATCH_KEYWORD_NAV_POLL_MS);
  }

  if (
    navigationContext.platform === 'douyin' &&
    await isKeywordSearchTargetReadyInTab(tabId, navigationContext)
  ) {
    return;
  }

  // 就绪判断在 15s 内没命中,并不代表导航失败:小红书是 SPA,导航后常把 URL 的 keyword
  // 参数改写/二次编码(甚至丢失),且搜索结果页的笔记链接是 /search_result/ 而非 /explore/,
  // 于是 isKeywordSearchTabUrlReady(要求 keyword 参数严格相等)与 isKeywordSearchDomReadyInTab
  // (小红书选择器多为 /explore/,且命中卡片后仍 return keywordMatched)会在"结果其实已经
  // 渲染出来"时双双误判未就绪,白白空等到超时再把整词判失败跳过。
  // 只要文档确实完成过加载(导航已真实发生),就不再抛错,把"到底有没有结果"交给随后
  // 的 waitForKeywordSearchResultsInTab；抖音还会要求关键词字面或提交前后作品集合替换证明。
  // 仅当文档从未加载完成(导航真的没发生/一直卡在 loading)时才按超时抛错。
  if (reachedComplete) {
    return;
  }

  throw new Error('搜索页导航超时');
}

function parseKeywordSearchNavigationContext(targetUrl = '') {
  try {
    const url = new URL(String(targetUrl || ''));
    const host = url.hostname.toLowerCase();
    if (host.includes('douyin.com')) {
      const keyword = decodeURIComponent(
        url.pathname.split('/search/')[1]?.split('/')[0] || '',
      );
      return {platform: 'douyin', keyword};
    }
    if (host.includes('xiaohongshu.com')) {
      return {
        platform: 'xiaohongshu',
        keyword: url.searchParams.get('keyword') || '',
      };
    }
  } catch {
    // ignore malformed URLs
  }
  return {platform: '', keyword: ''};
}

function isKeywordSearchTabUrlReady(currentUrl = '', {platform = '', keyword = ''} = {}) {
  const platformKey = String(platform || '').toLowerCase();
  const expectedKeyword = String(keyword || '').trim();
  if (!platformKey || !expectedKeyword) {
    return true;
  }
  try {
    const url = new URL(String(currentUrl || ''));
    const host = url.hostname.toLowerCase();
    let currentKeyword = '';
    if (platformKey === 'douyin' && host.includes('douyin.com')) {
      currentKeyword = decodeURIComponent(
        url.pathname.split('/search/')[1]?.split('/')[0] || '',
      );
    } else if (platformKey === 'xiaohongshu' && host.includes('xiaohongshu.com')) {
      currentKeyword = url.searchParams.get('keyword') || '';
    } else if (platformKey === 'weibo' && host.includes('weibo.com')) {
      currentKeyword = url.searchParams.get('q') || '';
    }
    const normalize = (value) =>
      String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    return normalize(currentKeyword) === normalize(expectedKeyword);
  } catch {
    return false;
  }
}

async function isKeywordSearchTargetReadyInTab(
  tabId,
  {platform = '', keyword = ''} = {},
) {
  const platformKey = String(platform || '').trim().toLowerCase();
  const expectedKeyword = String(keyword || '').trim();
  if (!platformKey || !expectedKeyword) {
    return false;
  }
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }

  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: (platformName, expectedKeywordValue) => {
        const normalize = (value) =>
          String(value || '').trim().toLowerCase().replace(/\s+/g, '');
        const decode = (value) => {
          try {
            return decodeURIComponent(String(value || ''));
          } catch {
            return String(value || '');
          }
        };
        const platformKeyInner = String(platformName || '').toLowerCase();
        const expected = normalize(expectedKeywordValue);
        const url = new URL(window.location.href);
        const urlKeyword =
          platformKeyInner === 'douyin'
            ? decode(url.pathname.split('/search/')[1]?.split('/')[0] || '')
            : url.searchParams.get('keyword') ||
              url.searchParams.get('query') ||
              url.searchParams.get('q') ||
              '';
        const inputKeyword =
          Array.from(
            document.querySelectorAll(
              '[data-e2e="searchbar-input"], input[type="search"], input[placeholder*="搜索"], textarea, [contenteditable="true"]',
            ),
          )
            .map((node) => node.value || node.textContent || '')
            .map((value) => String(value || '').trim())
            .find(Boolean) || '';
        const ready =
          Boolean(expected) &&
          (normalize(urlKeyword) === expected ||
            normalize(inputKeyword) === expected);
        console.log('[星语诊断] 切词就绪判断', {
          expected,
          urlKeyword,
          inputKeyword,
          ready,
          href: window.location.href,
        });
        return ready;
      },
      args: [platform, keyword],
    })
    .then(([result]) => Boolean(result?.result))
    .catch(() => false);
}

async function waitForKeywordSearchTargetReadyInTab(
  tabId,
  navigationContext = {},
  shouldStop = null,
  timeoutMs = 6000,
) {
  const startedAt = Date.now();
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() - startedAt < timeout) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }
    if (isDouyinPlatform(navigationContext?.platform)) {
      await assertNoDouyinSearchSecurityChallengeInTab(tabId);
    }
    if (await isKeywordSearchTargetReadyInTab(tabId, navigationContext)) {
      return true;
    }
    await waitMs(BATCH_KEYWORD_NAV_POLL_MS);
  }
  return false;
}

async function isKeywordSearchDomReadyInTab(
  tabId,
  {platform = '', keyword = ''} = {},
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }

  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: (platformName, expectedKeyword) => {
        const normalizeText = (value) =>
          String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '');
        const decode = (value) => {
          try {
            return decodeURIComponent(String(value || ''));
          } catch {
            return String(value || '');
          }
        };
        const platformKey = String(platformName || '').toLowerCase();
        const expected = normalizeText(expectedKeyword);
        const selectorsByPlatform = {
          xiaohongshu: [
            '.feeds-container a[href*="/explore/"]',
            '.note-item',
            '.feed-item',
            '.cover',
            'a[href*="/explore/"]',
            '[data-v-feed] a',
            'section a[href*="/explore/"]',
          ],
          douyin: [
            '#search-result-container .search-result-card',
            '#waterFallScrollContainer .search-result-card',
            '#search-result-container [id^="waterfall_item_"]',
            '#waterFallScrollContainer [id^="waterfall_item_"]',
            '.search-result-card',
            '[data-e2e-aweme-id]',
            '[data-aweme-id]',
            '[data-awemeid]',
            '[data-id]',
            '[data-item-id]',
            '[data-modal-id]',
            '[id^="waterfall_item_"]',
            'a[href*="/video/"]',
            'a[href*="/note/"]',
            'a[href*="modal_id="]',
            'a[data-href*="/video/"]',
            'a[data-href*="/note/"]',
            'a[data-url*="/video/"]',
            'a[data-url*="/note/"]',
          ],
        };
        const selectors =
          selectorsByPlatform[platformKey] ||
          Object.values(selectorsByPlatform).flat();
        const url = new URL(window.location.href);
        const urlKeyword =
          url.searchParams.get('keyword') ||
          url.searchParams.get('query') ||
          url.searchParams.get('q') ||
          (platformKey === 'douyin'
            ? decode(url.pathname.split('/search/')[1]?.split('/')[0] || '')
            : '');
        const inputKeyword =
          Array.from(
            document.querySelectorAll('input, textarea, [contenteditable="true"]'),
          )
            .map((node) => node.value || node.textContent || '')
            .map((value) => String(value || '').trim())
            .find(Boolean) || '';
        const normalizedInputKeyword = normalizeText(inputKeyword);
        const keywordMatched =
          !expected ||
          normalizeText(urlKeyword) === expected ||
          (platformKey === 'douyin'
            ? normalizedInputKeyword === expected
            : normalizedInputKeyword.includes(expected));
        const isVisible = (node) => {
          if (!(node instanceof Element)) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return (
            rect.width > 8 &&
            rect.height > 8 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.01
          );
        };
        const hasVisibleMedia = (node) =>
          Boolean(
            node?.querySelector?.(
              'img[src], video, canvas, [style*="background-image"]',
            ),
          );
        const hasDouyinResultSignal = (node) => {
          if (!(node instanceof Element)) {
            return false;
          }
          const text = String(node.innerText || node.textContent || '');
          if (/^\s*相关搜索(?:\s|$|[:：])/m.test(text)) {
            return false;
          }
          const linkSelectors = [
            'a[href*="/video/"]',
            'a[href*="/note/"]',
            'a[href*="modal_id="]',
            '[href*="/video/"]',
            '[href*="/note/"]',
            '[data-href*="/video/"]',
            '[data-href*="/note/"]',
            '[data-url*="/video/"]',
            '[data-url*="/note/"]',
          ].join(',');
          return (
            node.matches?.(linkSelectors) ||
            node.querySelector?.(linkSelectors) ||
            /^\s*\d{1,2}:\d{2}\s*$/m.test(text) ||
            hasVisibleMedia(node)
          );
        };
        let cardCount = 0;
        const seenNodes = new Set();
        for (const selector of selectors) {
          try {
            document.querySelectorAll(selector).forEach((node) => {
              const item =
                platformKey === 'douyin'
                  ? node.closest?.(
                      '.search-result-card, [id^="waterfall_item_"], [data-e2e-aweme-id], [data-aweme-id], [data-awemeid], [data-id], [data-item-id], [data-modal-id]',
                    ) || node
                  : node.closest?.('.note-item, .feed-item, section, [data-v-feed] a') ||
                    node;
              if (!item || seenNodes.has(item)) {
                return;
              }
              if (
                platformKey === 'douyin' &&
                !hasDouyinResultSignal(item) &&
                !isVisible(item)
              ) {
                return;
              }
              seenNodes.add(item);
              cardCount += 1;
            });
          } catch {
            // ignore invalid selectors
          }
        }
        if (platformKey === 'douyin' && cardCount <= 0) {
          const durationHits = Array.from(document.querySelectorAll('span, div'))
            .filter((node) => /^\s*\d{1,2}:\d{2}\s*$/.test(node.textContent || ''))
            .filter(isVisible).length;
          const searchTabsVisible =
            /综合/.test(document.body?.innerText || '') &&
            /视频/.test(document.body?.innerText || '');
          if (durationHits > 0 && searchTabsVisible) {
            cardCount = durationHits;
          }
          if (cardCount <= 0 && searchTabsVisible) {
            const mediaCards = new Set();
            Array.from(
              document.querySelectorAll(
                'main img[src], main video, #search-result-container img[src], #search-result-container video, #waterFallScrollContainer img[src], #waterFallScrollContainer video, [data-e2e="scroll-list"] img[src], [data-e2e="scroll-list"] video',
              ),
            ).forEach((node) => {
              const card =
                node.closest?.(
                  'a[href], article, li, section, [role="listitem"], .search-result-card, [id^="waterfall_item_"], [data-e2e-aweme-id], [data-aweme-id], [data-awemeid], [data-id], [data-item-id], [data-modal-id]',
                ) || node.parentElement;
              if (!card || !isVisible(card)) {
                return;
              }
              const text = String(card.innerText || card.textContent || '');
              if (/^\s*相关搜索(?:\s|$|[:：])/m.test(text)) {
                return;
              }
              mediaCards.add(card);
            });
            if (mediaCards.size > 0) {
              cardCount = mediaCards.size;
            }
          }
        }
        if (cardCount <= 0) {
          if (platformKey === 'douyin' && keywordMatched) {
            const bodyText = String(document.body?.innerText || '');
            const hasSearchShell =
              document.readyState !== 'loading' &&
              (Boolean(
                document.querySelector(
                  '[data-e2e="searchbar-input"], input[placeholder*="搜索"], #search-result-container, #waterFallScrollContainer',
                ),
              ) ||
                (/综合/.test(bodyText) && /视频|用户|直播/.test(bodyText)));
            if (hasSearchShell) {
              return true;
            }
          }
          return false;
        }
        return keywordMatched;
      },
      args: [platform, keyword],
    })
    .then(([result]) => Boolean(result?.result))
    .catch(() => false);
}

function isEmptyKeywordCaptureResult(captureResult) {
  if (!captureResult?.ok) {
    return false;
  }

  const payload =
    captureResult.data && typeof captureResult.data === 'object'
      ? captureResult.data
      : {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const rawTotalCount = Number(payload.rawTotalCount || payload.totalCount || 0);
  const filteredCount = Number(payload.filteredCount || items.length || 0);
  return items.length === 0 && rawTotalCount === 0 && filteredCount === 0;
}

function inspectKeywordSearchPageUrl(
  pageUrl = '',
  platform = '',
  expectedKeyword = '',
) {
  if (String(platform || '').trim().toLowerCase() !== 'douyin') {
    return {searchPathReady: true, keywordConflict: false};
  }
  try {
    const url = new URL(String(pageUrl || ''));
    const pathname = String(url.pathname || '').toLowerCase();
    const searchPathReady =
      !url.searchParams.has('modal_id') &&
      (pathname.startsWith('/search/') ||
        pathname.startsWith('/jingxuan/search'));
    const decodeRepeatedly = (value) => {
      let decoded = String(value || '');
      for (let index = 0; index < 2; index += 1) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      return decoded;
    };
    const normalize = (value) =>
      String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    const rawUrlKeyword =
      url.searchParams.get('keyword') ||
      url.searchParams.get('query') ||
      url.searchParams.get('q') ||
      pathname.split('/search/')[1]?.split('/')[0] ||
      '';
    const urlKeyword = normalize(decodeRepeatedly(rawUrlKeyword));
    const expected = normalize(expectedKeyword);
    return {
      searchPathReady,
      keywordConflict: Boolean(
        searchPathReady && expected && urlKeyword && urlKeyword !== expected,
      ),
    };
  } catch {
    return {searchPathReady: false, keywordConflict: false};
  }
}

async function readDouyinSearchSecurityChallengeStateInTab(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return {detected: false, pageUrl: ''};
  }
  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: () => {
        const pageUrl = String(window.location.href || '');
        let douyinPage = false;
        try {
          const url = new URL(pageUrl);
          const hostname = String(url.hostname || '').toLowerCase();
          douyinPage =
            hostname === 'douyin.com' || hostname.endsWith('.douyin.com');
        } catch {
          douyinPage = false;
        }
        if (!douyinPage) {
          return {detected: false, pageUrl};
        }

        const normalize = (value) =>
          String(value || '').trim().replace(/\s+/gu, '');
        const isChallengeText = (title, text) => {
          const normalizedTitle = normalize(title);
          const normalizedText = normalize(text);
          if (/^(?:验证码中间页|抖音验证码中间页)$/iu.test(normalizedTitle)) {
            return true;
          }
          if (/请完成下列验证后继续[:：]?/iu.test(normalizedText)) {
            return true;
          }
          return (
            /请选择所有符合(?:上文|上述|下列)?描述的图片/iu.test(
              normalizedText,
            ) &&
            /(?:并)?拖拽到(?:下方|这里)/iu.test(normalizedText)
          );
        };
        if (isChallengeText(document.title, '')) {
          return {
            detected: true,
            pageUrl,
            evidence: 'challenge_title',
          };
        }

        const isVisible = (node) => {
          if (!(node instanceof Element)) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 4 || rect.height <= 4) return false;
          let current = node;
          while (current && current.nodeType !== Node.DOCUMENT_NODE) {
            if (
              current.hidden === true ||
              String(current.getAttribute?.('aria-hidden') || '')
                .toLowerCase() === 'true'
            ) {
              return false;
            }
            const style = window.getComputedStyle(current);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              Number(style.opacity || 1) <= 0.01
            ) {
              return false;
            }
            current = current.parentElement;
          }
          return true;
        };
        const resultCardSelector = [
          '.search-result-card',
          '[id^="waterfall_item_"]',
          '[data-e2e-aweme-id]',
          '[data-aweme-id]',
          '[data-awemeid]',
          '[data-modal-id]',
          'a[href*="/video/"]',
          'a[href*="/note/"]',
          'a[href*="modal_id="]',
        ].join(',');
        const challengeNode = Array.from(
          document.querySelectorAll(
            '[role="dialog"], dialog, section, aside, h1, h2, h3, h4, p, span, div',
          ),
        )
          .find((node) => {
            if (!isVisible(node)) return false;
            if (node?.closest?.(resultCardSelector)) return false;
            // body/list wrappers aggregate descendant captions in innerText.
            // If any trusted result subtree sits below this candidate, inspect
            // the descendants instead of letting one quoted caption masquerade
            // as a page-level verification dialog.
            if (node?.querySelector?.(resultCardSelector)) return false;
            return isChallengeText(
              document.title,
              node?.innerText || node?.textContent || '',
            );
          });
        if (challengeNode) {
          return {
            detected: true,
            pageUrl,
            evidence: 'semantic_image_challenge',
          };
        }

        const challengeFrame = Array.from(
          document.querySelectorAll('iframe'),
        ).find((node) => {
          if (!isVisible(node)) return false;
          if (node?.closest?.(resultCardSelector)) return false;
          const evidence = normalize(
            [
              node.getAttribute?.('src'),
              node.getAttribute?.('title'),
              node.getAttribute?.('name'),
              node.id,
              node.className,
            ].join(' '),
          ).toLowerCase();
          return /captcha|verify|verification|challenge/iu.test(evidence);
        });
        return {
          detected: Boolean(challengeFrame),
          pageUrl,
          evidence: challengeFrame ? 'challenge_frame' : '',
        };
      },
    })
    .then(([result]) => result?.result || {detected: false, pageUrl: ''})
    .catch(() => ({detected: false, pageUrl: ''}));
}

async function assertNoDouyinSearchSecurityChallengeInTab(tabId) {
  const state = await readDouyinSearchSecurityChallengeStateInTab(tabId);
  if (!state?.detected) return state;
  const error = createDouyinSearchSecurityChallengeError({
    pageUrl: state.pageUrl,
  });
  error.evidence = String(state.evidence || '');
  throw error;
}

async function waitForKeywordSearchResultsInTab(
  tabId,
  platform = '',
  shouldStop = null,
  {
    timeoutMs = null,
    keyword = '',
    stablePolls = BATCH_KEYWORD_RESULTS_STABLE_POLLS,
    returnState = false,
    requireResultTransition = false,
    previousWorkIds = null,
    submitAccepted = false,
    submissionNonce = '',
    navigationTransitionAccepted = false,
    slowProgressExtensionMs = null,
    onSlowProgress = null,
  } = {},
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return returnState
      ? {
          ready: false,
          confirmedEmpty: false,
          emptyMessage: '',
          pageUrl: '',
        }
      : false;
  }

  const startedAt = Date.now();
  const isDouyinReadiness =
    String(platform || '').trim().toLowerCase() === 'douyin';
  const hasExplicitTimeout = timeoutMs !== null && timeoutMs !== undefined;
  const defaultTimeout =
    isDouyinReadiness
      ? DOUYIN_KEYWORD_RESULTS_READY_TIMEOUT_MS
      : BATCH_KEYWORD_RESULTS_READY_TIMEOUT_MS;
  const timeout = Math.max(
    0,
    hasExplicitTimeout ? Number(timeoutMs) || 0 : defaultTimeout,
  );
  const slowProgressExtension = Math.max(
    0,
    slowProgressExtensionMs === null || slowProgressExtensionMs === undefined
      ? isDouyinReadiness && !hasExplicitTimeout
        ? DOUYIN_KEYWORD_RESULTS_SLOW_PROGRESS_EXTENSION_MS
        : 0
      : Number(slowProgressExtensionMs) || 0,
  );
  const requiredStablePolls = Math.max(1, Math.floor(Number(stablePolls) || 1));
  const normalizedPreviousWorkIds = Array.from(
    new Set(
      (Array.isArray(previousWorkIds) ? previousWorkIds : [])
        .map((workId) => String(workId || '').trim())
        .filter((workId) => /^\d{8,}$/u.test(workId)),
    ),
  );
  const previousWorkIdSet = new Set(normalizedPreviousWorkIds);
  let lastSignature = '';
  let lastCardCount = -1;
  let stableCount = 0;
  let lastPageUrl = '';
  let lastServiceAbnormalSignature = '';
  let serviceAbnormalStableCount = 0;
  let serviceAbnormalFirstObservedAt = null;
  let slowProgressProbeUsed = false;
  let slowProgressReason = '';
  let activeTimeout = timeout;
  let currentAttemptResultsVisible = false;
  let lastObservedProgressSignature = '';
  let lastResultProgressAt = null;
  while (true) {
    const observedAt = Date.now();
    const elapsedMs = observedAt - startedAt;
    if (elapsedMs >= activeTimeout) {
      const resultProgressAgeMs = Number.isFinite(lastResultProgressAt)
        ? observedAt - lastResultProgressAt
        : null;
      const recentSignatureProgress = Boolean(
        Number.isFinite(resultProgressAgeMs) &&
          resultProgressAgeMs >= 0 &&
          resultProgressAgeMs <=
            DOUYIN_KEYWORD_RESULTS_PROGRESS_RECENCY_MS,
      );
      const canRunSlowProgressProbe = Boolean(
        isDouyinReadiness &&
          !slowProgressProbeUsed &&
          slowProgressExtension > 0 &&
          (currentAttemptResultsVisible || recentSignatureProgress),
      );
      if (!canRunSlowProgressProbe) {
        break;
      }
      slowProgressProbeUsed = true;
      slowProgressReason = currentAttemptResultsVisible
        ? 'visible_results_generation_unconfirmed'
        : 'result_signature_progress';
      activeTimeout = timeout + slowProgressExtension;
      if (typeof onSlowProgress === 'function') {
        try {
          await onSlowProgress({
            stage: 'results_visible_unconfirmed',
            reason: slowProgressReason,
            readinessCode: 'DOUYIN_RESULTS_VISIBLE_GENERATION_UNPROVEN',
            elapsedMs,
            extensionMs: slowProgressExtension,
          });
        } catch {
          // 可见性回调不得中断页面证据探测。
        }
      }
      if (elapsedMs >= activeTimeout) {
        break;
      }
    }
    if (typeof shouldStop === 'function' && shouldStop()) {
      throw new Error('BATCH_CAPTURE_CANCELED');
    }
    if (String(platform || '').trim().toLowerCase() === 'douyin') {
      await assertNoDouyinSearchSecurityChallengeInTab(normalizedTabId);
    }

    const snapshot = await chrome.scripting
      .executeScript({
        target: {tabId: normalizedTabId},
        func: (
          platformName,
          expectedKeyword,
          xhsMarkers,
          expectedSubmissionNonce,
        ) => {
          const normalizeText = (value) =>
            String(value || '')
              .trim()
              .toLowerCase()
              .replace(/\s+/g, '');
          const decode = (value) => {
            try {
              return decodeURIComponent(String(value || ''));
            } catch {
              return String(value || '');
            }
          };
          const expected = normalizeText(expectedKeyword);
          const platformKey = String(platformName || '').toLowerCase();
          if (platformKey === 'xiaohongshu') {
            const pageText = `${document.title || ''} ${document.body?.innerText || ''}`
              .replace(/[\u2010-\u2015]/gu, '-')
              .replace(/[\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f"']/gu, '')
              .replace(/\s+/gu, ' ')
              .trim()
              .toLowerCase();
            const chineseBlocked =
              pageText.includes(xhsMarkers.chineseTitle) &&
              pageText.includes(xhsMarkers.chineseRateLimit) &&
              pageText.includes(xhsMarkers.chineseRetry) &&
              (
                pageText.includes(xhsMarkers.chineseCode) ||
                xhsMarkers.chineseActions.every((action) =>
                  pageText.includes(action),
                )
              );
            const englishQrBlocked =
              pageText.includes(xhsMarkers.englishQrLead) &&
              pageText.includes(xhsMarkers.englishQrReason);
            const englishRateBlocked =
              pageText.includes(xhsMarkers.englishRateLimit) &&
              pageText.includes(xhsMarkers.englishRetry);
            const securityEvidence = chineseBlocked
              ? {
                  confirmed: true,
                  platform: 'xiaohongshu',
                  variant: 'cn_rate_limit_300013',
                  language: 'zh-CN',
                  reason: 'rate_limit',
                  pageUrl: window.location.href,
                }
              : englishQrBlocked
                ? {
                    confirmed: true,
                    platform: 'xiaohongshu',
                    variant: 'en_account_security_qr',
                    language: 'en',
                    reason: 'account_security_qr',
                    pageUrl: window.location.href,
                  }
                : englishRateBlocked
                  ? {
                      confirmed: true,
                      platform: 'xiaohongshu',
                      variant: 'en_rate_limit',
                      language: 'en',
                      reason: 'rate_limit',
                      pageUrl: window.location.href,
                    }
                  : null;
            if (securityEvidence) {
              return {
                cardCount: 0,
                keywordMatched: false,
                pageUrl: window.location.href,
                signature: '',
                blockingCode: 'XHS_SECURITY_BLOCK',
                blockingMessage:
                  securityEvidence.reason === 'account_security_qr'
                    ? '小红书要求扫码完成账号安全验证，已暂停采集'
                    : '小红书提示访问频繁，已暂停采集',
                securityEvidence,
              };
            }
          }
          const selectorsByPlatform = {
            xiaohongshu: [
              '.feeds-container a[href*="/explore/"]',
              '.note-item',
              '.feed-item',
              '.cover',
              'a[href*="/explore/"]',
              '[data-v-feed] a',
              'section a[href*="/explore/"]',
            ],
            douyin: [
              '#search-result-container .search-result-card',
              '#waterFallScrollContainer .search-result-card',
              '#search-result-container [id^="waterfall_item_"]',
              '#waterFallScrollContainer [id^="waterfall_item_"]',
              '[data-e2e="scroll-list"] .search-result-card',
              '[data-e2e="scroll-list"] [id^="waterfall_item_"]',
              '[data-e2e="scroll-list"] [data-e2e-aweme-id]',
              '[data-e2e="scroll-list"] [data-aweme-id]',
              '[data-e2e="scroll-list"] [data-awemeid]',
              '[data-e2e="scroll-list"] [data-modal-id]',
              '[data-e2e="scroll-list"] a[href*="/video/"]',
              '[data-e2e="scroll-list"] a[href*="/note/"]',
              '[data-e2e="scroll-list"] a[href*="modal_id="]',
              '[data-e2e="scroll-list"] a[data-href*="/video/"]',
              '[data-e2e="scroll-list"] a[data-href*="/note/"]',
              '[data-e2e="scroll-list"] a[data-url*="/video/"]',
              '[data-e2e="scroll-list"] a[data-url*="/note/"]',
              '#search-result-container [data-e2e-aweme-id]',
              '#search-result-container [data-aweme-id]',
              '#search-result-container [data-awemeid]',
              '#search-result-container [data-modal-id]',
              '#search-result-container a[href*="/video/"]',
              '#search-result-container a[href*="/note/"]',
              '#search-result-container a[href*="modal_id="]',
              '#search-result-container a[data-href*="/video/"]',
              '#search-result-container a[data-href*="/note/"]',
              '#search-result-container a[data-url*="/video/"]',
              '#search-result-container a[data-url*="/note/"]',
              '#waterFallScrollContainer [data-e2e-aweme-id]',
              '#waterFallScrollContainer [data-aweme-id]',
              '#waterFallScrollContainer [data-awemeid]',
              '#waterFallScrollContainer [data-modal-id]',
              '#waterFallScrollContainer a[href*="/video/"]',
              '#waterFallScrollContainer a[href*="/note/"]',
              '#waterFallScrollContainer a[href*="modal_id="]',
              '#waterFallScrollContainer a[data-href*="/video/"]',
              '#waterFallScrollContainer a[data-href*="/note/"]',
              '#waterFallScrollContainer a[data-url*="/video/"]',
              '#waterFallScrollContainer a[data-url*="/note/"]',
            ],
          };
          const selectors =
            selectorsByPlatform[platformKey] ||
            Object.values(selectorsByPlatform).flat();
          const isVisible = (node) => {
            if (!(node instanceof Element)) {
              return false;
            }
            const rect = node.getBoundingClientRect();
            if (rect.width <= 8 || rect.height <= 8) {
              return false;
            }
            let current = node;
            while (current && current.nodeType !== Node.DOCUMENT_NODE) {
              if (
                current.hidden === true ||
                String(current.getAttribute?.('aria-hidden') || '')
                  .toLowerCase() === 'true'
              ) {
                return false;
              }
              const style = window.getComputedStyle(current);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                Number(style.opacity || 1) <= 0.01
              ) {
                return false;
              }
              current = current.parentElement;
            }
            return true;
          };
          const douyinSearchPathReady = (() => {
            if (platformKey !== 'douyin') return false;
            try {
              const url = new URL(window.location.href);
              const hostname = String(url.hostname || '').toLowerCase();
              const pathname = String(url.pathname || '').toLowerCase();
              return (
                (hostname === 'douyin.com' ||
                  hostname.endsWith('.douyin.com')) &&
                (pathname === '/search' ||
                  pathname.startsWith('/search/') ||
                  pathname.startsWith('/jingxuan/search'))
              );
            } catch {
              return false;
            }
          })();
          const douyinResultLinkSelector = [
            'a[href*="/video/"]',
            'a[href*="/note/"]',
            'a[href*="modal_id="]',
            'a[data-href*="/video/"]',
            'a[data-href*="/note/"]',
            'a[data-url*="/video/"]',
            'a[data-url*="/note/"]',
          ].join(',');
          const douyinTrustedResultIdentitySelector = [
            '[id^="waterfall_item_"]',
            '[data-e2e-aweme-id]',
            '[data-aweme-id]',
            '[data-awemeid]',
            '[data-modal-id]',
            douyinResultLinkSelector,
          ].join(',');
          const isInsideDouyinResultCard = (node) => {
            if (!node?.closest) return false;
            if (node.closest(douyinTrustedResultIdentitySelector)) return true;
            const possibleCardContainer = node.closest(
              '.search-result-card, [data-id], [data-item-id]',
            );
            return Boolean(
              possibleCardContainer?.querySelector?.(
                douyinTrustedResultIdentitySelector,
              ),
            );
          };
          let serviceAbnormalNode = null;
          let confirmedEmptyNode = null;
          if (douyinSearchPathReady) {
            const maxDouyinSemanticStateCandidates = 64;
            let inspectedSemanticStateCandidates = 0;
            const semanticStateNodes = document.querySelectorAll(
              'h1, h2, h3, h4, p, span, div',
            );
            // One flat traversal recognizes both terminal states. Cheap
            // textContent checks happen first; layout/ancestor/subtree work is
            // reserved for at most 64 nodes whose short text actually matches
            // a service-abnormal or confirmed-empty phrase.
            for (const node of semanticStateNodes) {
              const rawText = String(node.textContent || '').trim();
              if (!rawText || rawText.length > 120) continue;
              const text = rawText.replace(/\s+/gu, '');
              const serviceAbnormalMatched =
                text === '服务出现异常' ||
                /^(?:服务出现异常)(?:，|,)?(?:请稍后重试)[。！!]?$/u.test(
                  text,
                );
              const confirmedEmptyMatched =
                /^(?:暂无)(?:相关)?(?:搜索)?(?:结果|内容|作品)[。！!]?$/u.test(text) ||
                /^(?:没有找到|没有搜索到|未找到|未搜索到)(?:相关)?(?:搜索)?(?:结果|内容|作品)[。！!]?$/u.test(text) ||
                /^(?:暂无|没有)(?:符合)?(?:当前)?筛选条件的?(?:结果|内容|作品)[。！!]?$/u.test(text);
              if (!serviceAbnormalMatched && !confirmedEmptyMatched) continue;
              if (
                inspectedSemanticStateCandidates >=
                maxDouyinSemanticStateCandidates
              ) {
                break;
              }
              inspectedSemanticStateCandidates += 1;
              if (!isVisible(node) || isInsideDouyinResultCard(node)) continue;
              if (serviceAbnormalMatched) {
                serviceAbnormalNode = node;
                break;
              }
              confirmedEmptyNode ||= node;
            }
          }
          if (serviceAbnormalNode) {
            return {
              cardCount: 0,
              keywordMatched: false,
              pageUrl: window.location.href,
              signature: '',
              blockingCode: 'DOUYIN_SEARCH_SERVICE_ABNORMAL',
              blockingMessage:
                '抖音当前关键词搜索暂时不可用，已结束本词并继续下一个关键词',
            };
          }
          const extractDouyinWorkIdFromUrlValue = (value) => {
            const raw = String(value || '').trim();
            if (!raw) return '';
            const candidates = Array.from(new Set([raw, decode(raw)]));
            const patterns = [
              /\/(?:video|note)\/(\d{8,})(?:[/?#]|$)/iu,
              /[?&]modal_id=(\d{8,})(?:[&#]|$)/iu,
            ];
            for (const candidate of candidates) {
              for (const pattern of patterns) {
                const matched = String(candidate).match(pattern);
                if (matched?.[1]) return matched[1];
              }
            }
            return '';
          };
          const resolveDouyinWorkId = (node) => {
            if (!(node instanceof Element)) return '';
            const identitySelector =
              '[id^="waterfall_item_"], [data-e2e-aweme-id], [data-aweme-id], [data-awemeid], [data-modal-id]';
            const candidateNodes = [];
            const seenCandidateNodes = new Set();
            const addCandidateNode = (candidateNode) => {
              if (
                !(candidateNode instanceof Element) ||
                seenCandidateNodes.has(candidateNode)
              ) {
                return;
              }
              seenCandidateNodes.add(candidateNode);
              candidateNodes.push(candidateNode);
            };
            addCandidateNode(node);
            addCandidateNode(node.closest?.(identitySelector));
            // Read at most one identity-bearing descendant and one detail link.
            // Readiness runs every ~300 ms, so a whole-subtree query per selector
            // would amplify large result DOMs without improving the first real ID.
            addCandidateNode(node.querySelector?.(identitySelector));
            addCandidateNode(
              node.matches?.(douyinResultLinkSelector)
                ? node
                : node.querySelector?.(douyinResultLinkSelector),
            );
            for (const candidateNode of candidateNodes) {
              const waterfallId = String(candidateNode.id || '').match(
                /^waterfall_item_(\d{8,})(?:$|[_:-])/u,
              )?.[1];
              if (waterfallId) return waterfallId;
              const dedicatedAttributeValues = [
                candidateNode.getAttribute?.('data-e2e-aweme-id'),
                candidateNode.getAttribute?.('data-aweme-id'),
                candidateNode.getAttribute?.('data-awemeid'),
                candidateNode.getAttribute?.('data-modal-id'),
              ];
              for (const value of dedicatedAttributeValues) {
                const workId = String(value || '').trim();
                if (/^\d{8,}$/u.test(workId)) return workId;
              }
              const linkValues = [
                candidateNode.getAttribute?.('href'),
                candidateNode.getAttribute?.('data-href'),
                candidateNode.getAttribute?.('data-url'),
              ];
              for (const value of linkValues) {
                const workId = extractDouyinWorkIdFromUrlValue(value);
                if (workId) return workId;
              }
            }
            return '';
          };
          const cardNodes = [];
          const seenNodes = new Set();
          const douyinWorkIdByNode = new Map();
          const maxDouyinCandidateNodes = 200;
          let inspectedDouyinCandidateNodes = 0;
          const addCardNode = (item) => {
            if (!item || seenNodes.has(item)) return;
            if (platformKey === 'douyin') {
              if (inspectedDouyinCandidateNodes >= maxDouyinCandidateNodes) {
                return;
              }
              inspectedDouyinCandidateNodes += 1;
              if (!isVisible(item)) return;
              const workId = resolveDouyinWorkId(item);
              if (!/^\d{8,}$/u.test(workId)) return;
              const text = String(item.innerText || item.textContent || '');
              if (/^\s*相关搜索(?:\s|$|[:：])/m.test(text)) return;
              douyinWorkIdByNode.set(item, workId);
            }
            seenNodes.add(item);
            cardNodes.push(item);
          };
          // Query once, normalize overlapping selectors, then resolve identity
          // once per unique card. The 200-card ceiling bounds a 300 ms poll even
          // if Douyin leaves a large virtualized result tree mounted.
          const candidateNodes = new Set();
          try {
            document.querySelectorAll(selectors.join(',')).forEach((node) => {
              const item =
                platformKey === 'douyin'
                  ? node.closest?.(
                      '.search-result-card, [id^="waterfall_item_"], [data-e2e-aweme-id], [data-aweme-id], [data-awemeid], [data-modal-id]',
                    ) || node
                  : node.closest?.('.note-item, .feed-item, section, [data-v-feed] a') ||
                    node;
              if (item) candidateNodes.add(item);
            });
          } catch {
            // All selectors are static and validated; a future invalid selector
            // should leave this poll empty instead of starting repeated scans.
          }
          candidateNodes.forEach(addCardNode);

          const url = new URL(window.location.href);
          const urlKeyword =
            url.searchParams.get('keyword') ||
            url.searchParams.get('query') ||
            url.searchParams.get('q') ||
            (platformKey === 'douyin'
              ? decode(url.pathname.split('/search/')[1]?.split('/')[0] || '')
              : '');
          const inputKeyword = Array.from(
            document.querySelectorAll('input, textarea, [contenteditable="true"]'),
          )
            .map((node) => node.value || node.textContent || '')
            .map((value) => String(value || '').trim())
            .find(Boolean) || '';
          const normalizedInputKeyword = normalizeText(inputKeyword);
          const keywordMatched =
            !expected ||
            normalizeText(urlKeyword) === expected ||
            (platformKey === 'douyin'
              ? normalizedInputKeyword === expected
              : normalizedInputKeyword.includes(expected));
          const workIds =
            platformKey === 'douyin'
              ? Array.from(
                  new Set(
                    cardNodes
                      .map((node) => douyinWorkIdByNode.get(node) || '')
                      .filter((workId) => /^\d{8,}$/u.test(workId)),
                  ),
                )
              : [];
          const signature =
            platformKey === 'douyin'
              ? `${workIds.length}:${workIds.join('|')}`
              : cardNodes
                  .slice(0, 8)
                  .map((node) => {
                    const link = node.matches?.('a[href]')
                      ? node
                      : node.querySelector?.('a[href]');
                    return [
                      link?.getAttribute?.('href') || '',
                      node.textContent || '',
                    ].join('|');
                  })
                  .join('||')
                  .slice(0, 2000);
          return {
            cardCount: cardNodes.length,
            keywordMatched,
            pageUrl: window.location.href,
            signature,
            workIds,
            postSubmitGenerationChanged:
              platformKey === 'douyin' &&
              Boolean(expectedSubmissionNonce) &&
              String(
                window.__STARVOICE_DOUYIN_SEARCH_WITNESS__?.nonce || '',
              ) === String(expectedSubmissionNonce) &&
              window.__STARVOICE_DOUYIN_SEARCH_WITNESS__
                ?.generationChanged === true,
            submissionNonce:
              platformKey === 'douyin'
                ? String(
                    window.__STARVOICE_DOUYIN_SEARCH_WITNESS__?.nonce || '',
                  )
                : '',
            confirmedEmpty: Boolean(confirmedEmptyNode),
            emptyMessage: confirmedEmptyNode
              ? String(
                  confirmedEmptyNode.innerText ||
                    confirmedEmptyNode.textContent ||
                    '',
                ).trim()
              : '',
          };
        },
        args: [
          platform,
          keyword,
          XHS_SECURITY_PAGE_MARKERS,
          submissionNonce,
        ],
      })
      .then(([result]) => result?.result || null)
      .catch(() => null);

    if (
      String(snapshot?.blockingCode || '').trim().toUpperCase() ===
      DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE
    ) {
      const serviceAbnormalSignature = [
        String(snapshot?.pageUrl || ''),
        DOUYIN_SEARCH_SERVICE_ABNORMAL_CODE,
        String(snapshot?.blockingMessage || ''),
      ].join('|');
      const sameServiceAbnormalSignature = Boolean(
        serviceAbnormalSignature &&
          serviceAbnormalSignature === lastServiceAbnormalSignature,
      );
      if (sameServiceAbnormalSignature) {
        serviceAbnormalStableCount += 1;
      } else {
        serviceAbnormalStableCount = 1;
        serviceAbnormalFirstObservedAt = Date.now();
      }
      lastServiceAbnormalSignature = serviceAbnormalSignature;
      stableCount = 0;
      lastSignature = '';
      lastCardCount = -1;
      if (
        serviceAbnormalStableCount >=
        Math.max(
          DOUYIN_SEARCH_SERVICE_ABNORMAL_STABLE_POLLS,
          requiredStablePolls,
        ) &&
        Number.isFinite(serviceAbnormalFirstObservedAt) &&
        Date.now() - serviceAbnormalFirstObservedAt >=
          DOUYIN_SEARCH_SERVICE_ABNORMAL_MIN_STABLE_MS
      ) {
        throw createDouyinSearchServiceAbnormalError({
          message: snapshot?.blockingMessage,
          pageUrl: snapshot?.pageUrl,
        });
      }
      await waitMsWithStop(
        Math.min(500, Math.max(100, BATCH_KEYWORD_NAV_POLL_MS)),
        shouldStop,
        'BATCH_CAPTURE_CANCELED',
      );
      continue;
    }
    lastServiceAbnormalSignature = '';
    serviceAbnormalStableCount = 0;
    serviceAbnormalFirstObservedAt = null;
    if (
      String(snapshot?.blockingCode || '').trim().toUpperCase() ===
      'XHS_SECURITY_BLOCK' &&
      snapshot?.securityEvidence?.confirmed === true
    ) {
      throw createXhsSecurityBlockError(snapshot.securityEvidence);
    }

    const douyinWorkIds = Array.from(
      new Set(
        (Array.isArray(snapshot?.workIds) ? snapshot.workIds : [])
          .map((workId) => String(workId || '').trim())
          .filter((workId) => /^\d{8,}$/u.test(workId)),
      ),
    );
    const cardCount = isDouyinReadiness
      ? douyinWorkIds.length
      : Number(snapshot?.cardCount || 0);
    const signature = isDouyinReadiness
      ? `${douyinWorkIds.length}:${douyinWorkIds.join('|')}`
      : String(snapshot?.signature || '');
    const keywordMatched = Boolean(snapshot?.keywordMatched);
    const {searchPathReady, keywordConflict} = inspectKeywordSearchPageUrl(
      snapshot?.pageUrl || '',
      platform,
      keyword,
    );
    lastPageUrl = String(snapshot?.pageUrl || '');
    const postSubmitGenerationChanged = Boolean(
      isDouyinReadiness &&
        submitAccepted === true &&
        String(submissionNonce || '') &&
        String(snapshot?.submissionNonce || '') ===
          String(submissionNonce || '') &&
        snapshot?.postSubmitGenerationChanged === true,
    );
    const matchingSubmissionWitness = Boolean(
      isDouyinReadiness &&
        submitAccepted === true &&
        String(submissionNonce || '') &&
        String(snapshot?.submissionNonce || '') ===
          String(submissionNonce || ''),
    );
    currentAttemptResultsVisible = Boolean(
      isDouyinReadiness &&
        searchPathReady &&
        !keywordConflict &&
        cardCount > 0 &&
        (keywordMatched ||
          navigationTransitionAccepted === true ||
          matchingSubmissionWitness),
    );
    if (
      currentAttemptResultsVisible &&
      signature &&
      signature !== lastObservedProgressSignature
    ) {
      lastObservedProgressSignature = signature;
      lastResultProgressAt = Date.now();
    }
    const confirmedEmpty =
      searchPathReady &&
      !keywordConflict &&
      keywordMatched &&
      (requireResultTransition !== true ||
        navigationTransitionAccepted === true ||
        (submitAccepted === true && postSubmitGenerationChanged)) &&
      snapshot?.confirmedEmpty === true;
    if (confirmedEmpty) {
      const emptyState = {
        ready: false,
        confirmedEmpty: true,
        emptyMessage:
          String(snapshot?.emptyMessage || '').trim() ||
          `「${keyword}」在当前筛选范围内没有匹配内容`,
        pageUrl: lastPageUrl,
      };
      return returnState ? emptyState : false;
    }
    const hasNewLeadingWorkId = Boolean(
      isDouyinReadiness &&
        normalizedPreviousWorkIds.length > 0 &&
        douyinWorkIds.length > 1 &&
        !previousWorkIdSet.has(douyinWorkIds[0]) &&
        douyinWorkIds
          .slice(1)
          .some((workId) => previousWorkIdSet.has(workId)),
    );
    // 输入框会先于结果卡更新，所以“关键词字面正确”只能证明提交目标，不能
    // 证明旧卡已经替换。点击提交必须再有同一 nonce 的完整 busy/clear/root
    // lifecycle，或“新首项插入、旧首屏仍在其后”的 DOM 顺序证据。严格子集、
    // 尾部追加及“旧头卸载 + 新尾加载”都可能只是虚拟列表滚动，不能放行。
    // 从不同关键词执行 tabs.update 并落到精确目标 URL 则由独立导航证据放行。
    const keywordMatchGraceElapsed =
      Date.now() - startedAt >= BATCH_KEYWORD_RESULTS_KEYWORD_MATCH_GRACE_MS;
    const readinessEvidenceAccepted =
      requireResultTransition === true
        ? navigationTransitionAccepted === true ||
          (submitAccepted === true &&
            (postSubmitGenerationChanged || hasNewLeadingWorkId))
        : keywordMatched || keywordMatchGraceElapsed;
    const resultsAccepted =
      searchPathReady &&
      !keywordConflict &&
      cardCount > 0 &&
      readinessEvidenceAccepted;
    if (
      resultsAccepted &&
      signature &&
      signature === lastSignature &&
      cardCount === lastCardCount
    ) {
      stableCount += 1;
    } else {
      stableCount = resultsAccepted ? 1 : 0;
      lastSignature = signature;
      lastCardCount = cardCount;
    }

    if (resultsAccepted && stableCount >= requiredStablePolls) {
      return returnState
        ? {
            ready: true,
            confirmedEmpty: false,
            emptyMessage: '',
            pageUrl: lastPageUrl,
            readinessCode: '',
            slowProgressProbeUsed,
            slowProgressReason,
            waitedMs: Date.now() - startedAt,
          }
        : true;
    }

    await waitMsWithStop(
      Math.min(500, Math.max(100, BATCH_KEYWORD_NAV_POLL_MS)),
      shouldStop,
      'BATCH_CAPTURE_CANCELED',
    );
  }

  return returnState
    ? {
        ready: false,
        confirmedEmpty: false,
        emptyMessage: '',
        pageUrl: lastPageUrl,
        readinessCode:
          isDouyinReadiness && slowProgressProbeUsed
            ? 'DOUYIN_RESULTS_VISIBLE_GENERATION_UNPROVEN'
            : isDouyinReadiness
              ? 'DOUYIN_SEARCH_RESULTS_NOT_READY'
              : '',
        slowProgressProbeUsed,
        slowProgressReason,
        waitedMs: Date.now() - startedAt,
      }
    : false;
}

async function closeKeywordSearchFilterPanelInTab(tabId) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    return false;
  }

  return chrome.scripting
    .executeScript({
      target: {tabId: normalizedTabId},
      func: async () => {
        const normalize = (value) =>
          String(value || '').trim().replace(/\s+/g, '');
        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return (
            rect.width > 1 &&
            rect.height > 1 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0.01
          );
        };
        const panelLabels = [
          '排序依据',
          '排序',
          '发布时间',
          '笔记类型',
          '内容形式',
          '搜索范围',
          '位置距离',
          '视频时长',
        ].map(normalize);
        const findPanel = () => {
          const nodes = document.querySelectorAll(
            '[class*="filter"], [class*="panel"], [class*="dropdown"], [class*="popup"], [class*="overlay"], [class*="screen"], section, aside, div',
          );
          for (const node of nodes) {
            if (!(node instanceof HTMLElement) || !isVisible(node)) {
              continue;
            }
            const text = normalize(node.innerText || node.textContent || '');
            if (text.length > 2200) {
              continue;
            }
            const hits = panelLabels.filter((label) => text.includes(label)).length;
            if (hits >= 2) {
              return node;
            }
          }
          return null;
        };
        const clickNode = (node) => {
          node.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
          node.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
          node.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        };
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const panel = findPanel();
        if (!panel) {
          return true;
        }
        const closeTexts = ['收起', '完成', '确定', '关闭'].map(normalize);
        const candidates = Array.from(
          document.querySelectorAll('button, [role="button"], a, span, div'),
        ).map((node) => {
          if (!(node instanceof HTMLElement) || !isVisible(node)) {
            return null;
          }
          const text = normalize(node.innerText || node.textContent || '');
          if (!closeTexts.some((label) => text === label || text.includes(label))) {
            return null;
          }
          return (
            node.closest('button, [role="button"], a, [class*="close"], [class*="fold"], [class*="collapse"]') ||
            node
          );
        }).filter(Boolean);
        for (const candidate of candidates.slice(0, 6)) {
          clickNode(candidate);
          await wait(350);
          if (!findPanel()) {
            return true;
          }
        }
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        await wait(350);
        return !findPanel();
      },
    })
    .then(([result]) => Boolean(result?.result))
    .catch(() => false);
}

async function captureInActiveTab({
  mode = 'auto',
  onProgress = null,
  captureParams = {},
  onTargetTab = null,
} = {}) {
  if (onProgress) {
    onProgress({
      phase: 'checking_page',
      message: '正在连接当前页面...',
    });
  }

  const tab = await resolveCaptureTargetTab({ mode });
  if (!tab?.id) {
    throw new Error('未找到当前活动标签页');
  }
  if (typeof onTargetTab === 'function') {
    try {
      onTargetTab(tab);
    } catch {
      // 仅用于回写本地 trace，回调失败不影响采集。
    }
  }

  return captureInTab(tab.id, {
    mode,
    captureParams,
  });
}

function resolveExpectedPageTypeForCaptureMode(mode) {
  switch (mode) {
    case 'single':
    case 'comments':
      return PAGE_TYPE.NOTE_DETAIL;
    case 'blogger_profile':
    case 'blogger_notes':
      return PAGE_TYPE.BLOGGER_PROFILE;
    case 'keyword':
      return PAGE_TYPE.SEARCH_RESULTS;
    default:
      return '';
  }
}

function isSupportedCaptureTab(tab) {
  const platform = detectPlatformFromUrl(String(tab?.url || ''));
  return platform === 'xiaohongshu' || platform === 'douyin';
}

function normalizeSupportedPlatform(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'xiaohongshu' || normalized === 'douyin'
    ? normalized
    : '';
}

function isUsableCaptureTab(tab, runtime, expectedPageType = '') {
  if (!tab?.id || !isSupportedCaptureTab(tab)) {
    return false;
  }

  const tabUrl = String(tab?.url || '');
  const tabPlatform = detectPlatformFromUrl(tabUrl);
  const runtimePlatform =
    normalizeSupportedPlatform(detectPlatformFromUrl(String(runtime?.lastPageUrl || ''))) ||
    normalizeSupportedPlatform(runtime?.platform);

  if (runtimePlatform && tabPlatform !== runtimePlatform) {
    return false;
  }

  if (expectedPageType) {
    return detectPageType(tabUrl) === expectedPageType;
  }

  return true;
}

async function resolveCaptureTargetTab({ mode = 'auto' } = {}) {
  const expectedPageType = resolveExpectedPageTypeForCaptureMode(mode);
  const runtime = await getRuntime().catch(() => ({}));
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (isUsableCaptureTab(activeTab, runtime, expectedPageType)) {
    return activeTab;
  }

  const runtimeTabId = Number(runtime?.lastActiveTabId);
  if (
    Number.isFinite(runtimeTabId) &&
    runtimeTabId > 0 &&
    runtimeTabId !== Number(activeTab?.id)
  ) {
    try {
      const runtimeTab = await chrome.tabs.get(runtimeTabId);
      if (isUsableCaptureTab(runtimeTab, runtime, expectedPageType)) {
        return runtimeTab;
      }
    } catch {
      // Fall through to the active tab error path below.
    }
  }

  return activeTab || null;
}

async function captureInTab(
  tabId,
  {
    mode = 'auto',
    captureParams = {},
  } = {},
) {
  const normalizedTabId = Number(tabId);
  if (!Number.isFinite(normalizedTabId) || normalizedTabId <= 0) {
    throw new Error('未找到可用标签页');
  }

  const taskContext = getActiveTaskContext();
  const captureRequestId =
    String(captureParams?.captureRequestId || '').trim() ||
    createCaptureRequestId('capture');
  const payload = appendTaskContext(
    {
      ...buildContentRequest(mode, captureParams),
      captureRequestId,
      recordId: String(captureParams?.recordId || ''),
      current: Number(captureParams?.current) || 0,
      total: Number(captureParams?.total) || 0,
      runnerTabId: normalizedTabId,
    },
    taskContext,
  );
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE.RELAY_TO_CONTENT,
    tabId: normalizedTabId,
    payload,
  });

  if (!response?.ok) {
    const message =
      response?.error?.message ||
      '无法连接到页面采集脚本，请刷新当前页面后重试';
    const error = new Error(message);
    error.code = String(response?.error?.code || 'RELAY_TO_CONTENT_FAILED');
    void recordDiagnosticError({
      taskContext,
      source: 'capture-sync',
      action: payload?.action || mode,
      status: 'failed',
      error,
      metadata: {
        phase: 'relay_to_content',
      },
    }).catch(() => null);
    throw error;
  }

  const contentResponse = response.data;
  if (contentResponse?.ok === false) {
    void recordDiagnosticError({
      taskContext: contentResponse.taskContext || taskContext,
      source: 'content',
      action: payload?.action || mode,
      status: 'failed',
      error: contentResponse.error || contentResponse,
      metadata: {
        phase: 'content_response',
      },
    }).catch(() => null);
  } else {
    const stageTrace = Array.isArray(contentResponse?.diagnostics?.stageTrace)
      ? contentResponse.diagnostics.stageTrace
      : [];
    for (const stage of stageTrace.slice(0, 12)) {
      await recordDiagnosticStage({
        ...stage,
        taskContext: contentResponse?.taskContext || taskContext,
        featureKey:
          stage?.featureKey ||
          stage?.parentFeatureKey ||
          contentResponse?.featureKey ||
          taskContext?.featureKey ||
          '',
        source: stage?.source || 'content',
      }).catch(() => null);
    }
    await recordDiagnosticAction({
      taskContext: contentResponse?.taskContext || taskContext,
      source: 'content',
      action: payload?.action || mode,
      status: 'completed',
      metadata: {
        mode,
        type: contentResponse?.type || '',
      },
    }).catch(() => null);
  }

  return response.data;
}

function buildContentRequest(mode, captureParams = {}) {
  switch (mode) {
    case 'auto':
      return { action: 'smartCapture', mode: 'auto' };
    case 'single':
      return {
        action: 'captureSingleNote',
        expectedNoteId: String(captureParams.expectedNoteId || ''),
        includeBloggerMetrics: Boolean(captureParams.includeBloggerMetrics),
        preferWorksTabForBloggerMetrics: Boolean(
          captureParams.preferWorksTabForBloggerMetrics,
        ),
      };
    case 'blogger_profile':
      return { action: 'captureBloggerProfile' };
    case 'blogger_notes':
      return {
        action: 'captureBloggerNotes',
        listCaptureRunId: captureParams.listCaptureRunId,
        minLikes: captureParams.minLikes,
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        keywordFilter: captureParams.keywordFilter || '',
        deferKeywordFilter: Boolean(captureParams.deferKeywordFilter),
        profileMetrics: captureParams.profileMetrics,
        monitorPublishWindow: captureParams.monitorPublishWindow || '',
        monitorObserveWindowHours: captureParams.monitorObserveWindowHours,
        monitorLikeThreshold: captureParams.monitorLikeThreshold,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
        maxDurationMs: captureParams.maxDurationMs,
        maxScrollTimes: captureParams.maxScrollTimes,
      };
    case 'keyword':
      return {
        action: 'captureKeywordNotes',
        listCaptureRunId: captureParams.listCaptureRunId,
        keyword: captureParams.keyword || '',
        minLikes: captureParams.minLikes,
        sortDimension: captureParams.sortDimension,
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        maxDurationMs: captureParams.maxDurationMs,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
        maxScrollTimes: captureParams.maxScrollTimes,
      };
    case 'comments':
      return {
        action: 'captureComments',
        expectedNoteId: String(captureParams.expectedNoteId || ''),
        verifiedNoteId: String(captureParams.verifiedNoteId || ''),
        onlyLevel1: Boolean(captureParams.onlyLevel1),
        maxDetectedItems:
          captureParams.maxDetectedItems ?? captureParams.maxItems,
        maxDurationMs: captureParams.maxDurationMs,
        noNewContentThreshold: captureParams.noNewContentThreshold,
        waitMinMs: captureParams.waitMinMs,
        waitMaxMs: captureParams.waitMaxMs,
        stallTimeoutMs: captureParams.stallTimeoutMs,
        maxScrollTimes: captureParams.maxScrollTimes,
      };
    default:
      throw new Error(`未知的采集模式: ${mode}`);
  }
}
