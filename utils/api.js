/**
 * StarVoice V1.0 API Layer
 * 封装与后端的通信，统一处理请求和响应
 */

import { API_ENDPOINT, ERROR_REASON, DEFAULT_CONFIG } from './constants.js';
import { getAuth, getRuntime } from './storage.js';
import { ensurePlainAuthCode } from './auth-code.js';
import { appendTaskContext } from './task-context.js';
import { recordDiagnosticError } from './diagnostics.js';

// ==================== 配置 ====================

// Credentials and captured business data must never be replayed across trust
// origins. Development can opt into one local backend explicitly; production
// uses only the production origin and does not silently fall back to localhost.
const API_BASE_URLS = [
  globalThis.__ONSTARVOICE_API_BASE_URL__ || 'https://voice.minilife.online',
]
  .map((value) => String(value || '').trim().replace(/\/$/, ''))
  .filter((baseUrl, index, values) => baseUrl && values.indexOf(baseUrl) === index);

let activeApiBaseUrl = API_BASE_URLS[0];

const RELEVANCE_PREFILTER_IDEMPOTENCY_KEY_MAX_LENGTH = 512;

/**
 * Older callers built relevance-prefilter keys from list content only. The
 * request layer later appends the active capture taskId, so a second capture
 * run could send a different logical body under the same key. Scope the key to
 * requestId as a final API-boundary safeguard. Repeating the same HTTP request
 * remains idempotent; a new prefilter request cannot collide with an older run.
 */
export function scopeRelevancePrefilterIdempotencyKey(
  idempotencyKey = '',
  requestId = '',
) {
  const baseKey = String(idempotencyKey || '').trim();
  const normalizedRequestId = String(requestId || '').trim().slice(0, 200);
  if (!baseKey || !normalizedRequestId) return baseKey;

  const suffix = `:request:${normalizedRequestId}`;
  const unscopedBaseKey = baseKey.endsWith(suffix)
    ? baseKey.slice(0, -suffix.length)
    : baseKey;
  const maxBaseLength = Math.max(
    0,
    RELEVANCE_PREFILTER_IDEMPOTENCY_KEY_MAX_LENGTH - suffix.length,
  );
  return `${unscopedBaseKey.slice(0, maxBaseLength)}${suffix}`;
}

// ==================== 通用请求函数 ====================

function isRequestCancellationRequested(shouldStop, signal = null) {
  if (signal?.aborted === true) return true;
  if (typeof shouldStop !== 'function') return false;
  try {
    return shouldStop() === true;
  } catch {
    // A broken cancellation source must fail closed for write requests.
    return true;
  }
}

function buildCanceledRequestResult() {
  return {
    ok: false,
    status: 'canceled',
    reason: 'capture_task_canceled',
    message: '任务已取消，未继续同步',
    error: null,
    data: null,
    canceled: true,
    __canceled: true,
  };
}

/**
 * 统一请求函数
 */
async function request(endpoint, options = {}) {
  const {
    method = 'POST',
    body = null,
    timeout = DEFAULT_CONFIG.REQUEST_TIMEOUT,
    shouldStop = null,
    signal = null,
    maxBaseAttempts = null,
  } = options;

  const configuredBaseUrls = [
    activeApiBaseUrl,
    ...API_BASE_URLS.filter(base => base !== activeApiBaseUrl),
  ];
  const normalizedMaxBaseAttempts = Number(maxBaseAttempts);
  const baseUrls =
    Number.isSafeInteger(normalizedMaxBaseAttempts) &&
    normalizedMaxBaseAttempts > 0
      ? configuredBaseUrls.slice(0, normalizedMaxBaseAttempts)
      : configuredBaseUrls;
  let lastUnavailableResult = null;

  for (const baseUrl of baseUrls) {
    if (isRequestCancellationRequested(shouldStop, signal)) {
      return buildCanceledRequestResult();
    }
    const result = await requestOnce(baseUrl, endpoint, {
      method,
      body,
      timeout,
      shouldStop,
      signal,
    });
    if (result?.__canceled) return result;
    if (!result?.__networkError && !result?.__endpointMissing) {
      activeApiBaseUrl = baseUrl;
      return result;
    }
    lastUnavailableResult = result;
  }

  return lastUnavailableResult;
}

async function requestOnce(baseUrl, endpoint, options = {}) {
  const {
    method = 'POST',
    body = null,
    timeout = DEFAULT_CONFIG.REQUEST_TIMEOUT,
    shouldStop = null,
    signal = null,
  } = options;

  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }

  const url = `${baseUrl}${endpoint}`;
  const requestBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? appendTaskContext(body)
      : body;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  let canceled = signal?.aborted === true;
  const abortFromCaller = () => {
    canceled = true;
    controller.abort();
  };
  signal?.addEventListener?.('abort', abortFromCaller, {once: true});
  const cancellationPollId =
    typeof shouldStop === 'function'
      ? setInterval(() => {
          if (!isRequestCancellationRequested(shouldStop, signal)) return;
          canceled = true;
          controller.abort();
        }, 75)
      : null;
  const clearRequestTimers = () => {
    clearTimeout(timeoutId);
    if (cancellationPollId !== null) clearInterval(cancellationPollId);
    signal?.removeEventListener?.('abort', abortFromCaller);
  };

  try {
    if (isRequestCancellationRequested(shouldStop, signal)) {
      canceled = true;
      return buildCanceledRequestResult();
    }
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody ? JSON.stringify(requestBody) : null,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (data && typeof data === 'object' && 'ok' in data) {
      if (data.ok) {
        return {
          ...data,
          error: null,
        };
      }

      void recordDiagnosticError({
        source: 'api',
        action: endpoint,
        status: 'failed',
        error: {
          reason: data.reason,
          message: data.message,
        },
      }).catch(() => null);

      return {
        ...data,
        error: {
          reason: data.reason,
          message: data.message,
        },
      };
    }

    if (!response.ok) {
      const reason =
        response.status === 404
          ? ERROR_REASON.NOT_FOUND
          : response.status === 403
            ? ERROR_REASON.FORBIDDEN
            : ERROR_REASON.SERVER_ERROR;
      const responseMessage =
        data && typeof data === 'object' && typeof data.message === 'string'
          ? data.message
          : '';
      const message =
        responseMessage ||
        (reason === ERROR_REASON.NOT_FOUND
          ? `接口不存在（HTTP 404）：${url}`
          : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      const error = {
        reason,
        message,
        httpStatus: response.status,
        url,
      };

      void recordDiagnosticError({
        source: 'api',
        action: endpoint,
        status: 'failed',
        error,
        metadata: {
          httpStatus: response.status,
        },
      }).catch(() => null);

      return {
        ok: false,
        status: 'error',
        reason: error.reason,
        message: error.message,
        error,
        data,
        __endpointMissing: response.status === 404,
      };
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      if (canceled || isRequestCancellationRequested(shouldStop, signal)) {
        return buildCanceledRequestResult();
      }
      const timeoutError = {
        reason: ERROR_REASON.TIMEOUT,
        message: 'Request timeout',
      };

      void recordDiagnosticError({
        source: 'api',
        action: endpoint,
        status: 'failed',
        error: timeoutError,
      }).catch(() => null);

      return {
        ok: false,
        status: 'error',
        reason: timeoutError.reason,
        message: timeoutError.message,
        error: timeoutError,
        data: null,
        __networkError: true,
      };
    }

    const networkError = {
      reason: ERROR_REASON.NETWORK_ERROR,
      message: `${error.message || 'Network error'}（后台地址：${baseUrl}）`,
      url,
    };

    void recordDiagnosticError({
      source: 'api',
      action: endpoint,
      status: 'failed',
      error: networkError,
    }).catch(() => null);

    return {
      ok: false,
      status: 'error',
      reason: networkError.reason,
      message: networkError.message,
      error: networkError,
      data: null,
      __networkError: true,
    };
  } finally {
    clearRequestTimers();
  }
}

async function resolvePlainAuthCodeFromCurrentAuth() {
  const auth = await getAuth();
  let plainCode = '';
  try {
    plainCode = await ensurePlainAuthCode(auth.code);
  } catch {
    plainCode = '';
  }

  if (!plainCode) {
    return {
      ok: false,
      status: 'error',
      reason: ERROR_REASON.VERIFY_FAILED,
      message: 'No auth code found',
      data: null,
    };
  }

  return {
    ok: true,
    code: plainCode,
  };
}

// ==================== POST /api/verify ====================

/**
 * 验证凭证
 * @param {string} code - 订单号或激活码
 * @param {Object} options - 可选参数
 * @param {string} options.replaceBindingId - 需要替换的旧环境 ID
 * @returns {Promise<Object>} 验证结果
 */
export async function verify(code, options = {}) {
  let plainCode = '';
  try {
    plainCode = await ensurePlainAuthCode(code);
  } catch {
    plainCode = '';
  }

  if (!plainCode) {
    return {
      ok: false,
      status: 'error',
      reason: 'INVALID_CODE',
      message: 'Invalid auth code',
      data: null,
    };
  }

  const runtime = await getRuntime();

  const body = {
    code: plainCode,
    clientUuid: runtime.clientUuid,
    clientLabel: runtime.clientLabel,
    appVersion: runtime.appVersion,
  };

  if (typeof options.replaceBindingId === 'string' && options.replaceBindingId) {
    body.replaceBindingId = options.replaceBindingId;
  }

  return await request(API_ENDPOINT.VERIFY, { body });
}

// ==================== POST /api/sync ====================

/**
 * 同步数据到后台
 * @param {Object} params - 同步参数
 * @param {string} params.syncType - 同步类型
 * @param {Object} params.target - 同步目标配置
 * @param {Object} params.payload - 业务数据
 * @returns {Promise<Object>} 同步结果
 */
export async function sync({ syncType, target, payload }, options = {}) {
  const shouldStop = options?.shouldStop;
  const signal = options?.signal || null;
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  const runtime = await getRuntime();
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const body = {
    code: authCodeResult.code,
    clientUuid: runtime.clientUuid,
    clientLabel: runtime.clientLabel,
    appVersion: runtime.appVersion,
    syncType,
    target,
    payload,
  };

  return await request(API_ENDPOINT.SYNC, {body, shouldStop, signal});
}

// ==================== 批量同步 ====================

/**
 * 批量同步多条记录
 * @param {Array<Object>} records - 记录列表（{ id, type, payload }）
 * @param {Object} target - 同步目标配置
 * @returns {Promise<Object>} 批量同步结果
 */
export async function syncBatch(records, target, options = {}) {
  const shouldStop = options?.shouldStop;
  const signal = options?.signal || null;
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  const runtime = await getRuntime();
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: false,
      status: 'error',
      reason: ERROR_REASON.INVALID_REQUEST,
      message: 'No records to sync',
      data: null,
    };
  }

  const body = {
    code: authCodeResult.code,
    clientUuid: runtime.clientUuid,
    clientLabel: runtime.clientLabel,
    appVersion: runtime.appVersion,
    target,
    records: records.map((record) => ({
      recordId: record.id,
      syncType: record.type,
      platform: record.platform,
      workflow: record.workflow,
      monitorExecutionId: record.monitorExecutionId || '',
      payload: record.payload,
    })),
  };

  return await request(API_ENDPOINT.SYNC_BATCH, {body, shouldStop, signal});
}

// 增量采集:问后端这批 external_id 哪些已采全(detailCaptureStatus=done)。
// 返回 { ok, captured:[external_id...], items:[{ externalId, commentsCount, commentsBaselineCount, capturedAt }] }。
// 失败时 captured/items 为空(不影响主流程,顶多多采几条)。
export async function checkCapturedExternalIds({ platform = '', externalIds = [] } = {}) {
  const ids = Array.isArray(externalIds)
    ? externalIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (ids.length === 0) return { ok: true, captured: [], items: [] };
  const runtime = await getRuntime();
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) return { ok: false, captured: [], items: [] };
  const body = {
    code: authCodeResult.code,
    clientUuid: runtime.clientUuid,
    appVersion: runtime.appVersion,
    platform,
    externalIds: ids,
  };
  const result = await request('/api/sync/captured', { body });
  return {
    ok: Boolean(result?.ok),
    captured: Array.isArray(result?.captured) ? result.captured : [],
    items: Array.isArray(result?.items) ? result.items : [],
  };
}

export async function getTargetConfig() {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const query = new URLSearchParams({
    code: authCodeResult.code,
  });

  return await request(`${API_ENDPOINT.TARGET}?${query.toString()}`, {
    method: 'GET',
  });
}

export async function saveTargetConfig(target) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.TARGET, {
    method: 'PUT',
    body: {
      code: authCodeResult.code,
      target,
    },
  });
}

export async function analyzeKeywords({
  seedKeyword = '',
  keywords = [],
  platform = '',
} = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.KEYWORD_ANALYSIS, {
    body: {
      code: authCodeResult.code,
      seedKeyword,
      keywords,
      platform,
    },
    timeout: DEFAULT_CONFIG.KEYWORD_ANALYSIS_TIMEOUT,
  });
}

export async function analyzeKeywordOpportunity({
  keyword = '',
  listItems = [],
  representativeSamples = [],
  platform = '',
} = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.KEYWORD_OPPORTUNITY, {
    body: {
      code: authCodeResult.code,
      keyword,
      listItems,
      representativeSamples,
      platform,
    },
    timeout: DEFAULT_CONFIG.KEYWORD_OPPORTUNITY_TIMEOUT,
  });
}

export async function analyzeBenchmarkDiscovery({
  keyword = '',
  platform = '',
  candidates = [],
} = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.BENCHMARK_DISCOVERY, {
    body: {
      code: authCodeResult.code,
      keyword,
      platform,
      candidates,
    },
    timeout: DEFAULT_CONFIG.BENCHMARK_DISCOVERY_TIMEOUT,
  });
}

// AI 前置相关性筛选。该接口属于采集加速的可选能力：扩展只提交列表页
// 的必要文字证据，模型调用和密钥始终留在后台。这里限制为单一后台地址和
// 有上限的等待；调用方使用小批次，让健康的 DeepSeek 响应能在截止前返回，
// 同时避免接口尚未部署、限流或模型不可用时无限拖慢原采集链路。
export async function prefilterRelevance(
  {
    requestId = '',
    idempotencyKey = '',
    platform = '',
    stage = 'list',
    keyword = '',
    promptVersion = 'prefilter-list-v2',
    mode = 'conservative',
    skipThreshold = 0.97,
    items = [],
  } = {},
  options = {},
) {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (!String(keyword || '').trim() || normalizedItems.length === 0) {
    return {
      ok: false,
      status: 'error',
      reason: ERROR_REASON.INVALID_REQUEST,
      message: 'AI 相关性筛选缺少关键词或候选内容',
      data: null,
    };
  }

  const shouldStop = options?.shouldStop;
  const signal = options?.signal || null;
  if (isRequestCancellationRequested(shouldStop, signal)) {
    return buildCanceledRequestResult();
  }

  const runtime = await getRuntime();
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) return authCodeResult;

  const normalizedRequestId = String(requestId || '').trim();
  const scopedIdempotencyKey = scopeRelevancePrefilterIdempotencyKey(
    idempotencyKey,
    normalizedRequestId,
  );

  return await request(
    API_ENDPOINT.RELEVANCE_PREFILTER || '/api/relevance/prefilter',
    {
      body: {
        code: authCodeResult.code,
        clientUuid: runtime.clientUuid,
        clientLabel: runtime.clientLabel,
        appVersion: runtime.appVersion,
        requestId: normalizedRequestId,
        idempotencyKey: scopedIdempotencyKey,
        platform: String(platform || '').trim().toLowerCase(),
        stage: String(stage || 'list').trim().toLowerCase(),
        keyword: String(keyword || '').trim(),
        promptVersion: String(promptVersion || 'prefilter-list-v2').trim(),
        mode: String(mode || 'conservative').trim().toLowerCase(),
        skipThreshold: Math.max(0.97, Math.min(1, Number(skipThreshold) || 0.97)),
        items: normalizedItems,
      },
      timeout: Math.max(500, Math.min(120000, Number(options?.timeout) || 90000)),
      shouldStop,
      signal,
      maxBaseAttempts: 1,
    },
  );
}

export async function getUpdateManifest() {
  return await request(API_ENDPOINT.UPDATE_MANIFEST, {
    method: 'GET',
    timeout: 10000,
  });
}

// ==================== Monitor API ====================

export async function listMonitorSubscriptions({ status = 'all', platform = '' } = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const query = new URLSearchParams({
    code: authCodeResult.code,
  });

  if (status && status !== 'all') {
    query.set('status', status);
  }
  if (platform) {
    query.set('platform', platform);
  }

  return await request(
    `${API_ENDPOINT.MONITOR_SUBSCRIPTIONS}?${query.toString()}`,
    { method: 'GET' }
  );
}

function normalizeMonitorSubscriptionText(value) {
  return String(value || '').trim();
}

export function normalizeMonitorSubscriptionPayload(input = {}) {
  const subjectType =
    normalizeMonitorSubscriptionText(input.subjectType || input.subject_type)
      .toLowerCase() === 'official'
      ? 'official'
      : 'creator';
  const profileInternalId = normalizeMonitorSubscriptionText(
    input.profileInternalId ||
      input.profile_internal_id ||
      input.platformBloggerId ||
      input.bloggerId
  );
  const accountNo = normalizeMonitorSubscriptionText(
    input.accountNo ||
      input.account_no ||
      input.douyinId ||
      input.redId ||
      input.bloggerUserId
  );
  const displayName = normalizeMonitorSubscriptionText(
    input.displayName ||
      input.display_name ||
      input.bloggerNameSnapshot ||
      input.bloggerName ||
      input.name
  );
  const profileUrl = normalizeMonitorSubscriptionText(
    input.profileUrl ||
      input.profile_url ||
      input.bloggerUrl ||
      input.bloggerProfileUrl ||
      input.accountUrl
  );
  const avatarUrl = normalizeMonitorSubscriptionText(
    input.avatarUrl ||
      input.avatar_url ||
      input.bloggerAvatarSnapshot
  );
  const platformBloggerId = normalizeMonitorSubscriptionText(
    input.platformBloggerId || profileInternalId || accountNo
  );
  const assignedAgentId = normalizeMonitorSubscriptionText(
    input.assignedAgentId || input.assigned_agent_id
  );

  return {
    ...input,
    subjectType,
    profileInternalId,
    accountNo,
    displayName,
    profileUrl,
    avatarUrl,
    assignedAgentId,
    // Keep the legacy monitor fields while clients and servers migrate to the
    // explicit subject identity contract.
    platformBloggerId,
    bloggerNameSnapshot: displayName,
    bloggerUrl: profileUrl,
    bloggerAvatarSnapshot: avatarUrl,
  };
}

export async function createMonitorSubscription(input = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const payload = normalizeMonitorSubscriptionPayload(input);
  return await request(API_ENDPOINT.MONITOR_SUBSCRIPTIONS, {
    body: {
      ...payload,
      code: authCodeResult.code,
    },
  });
}

export async function listMonitorExecutions({
  subscriptionId = '',
  status = '',
  limit = 50,
} = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const query = new URLSearchParams({
    code: authCodeResult.code,
    limit: String(limit),
  });

  if (subscriptionId) {
    query.set('subscriptionId', subscriptionId);
  }
  if (status) {
    query.set('status', status);
  }

  return await request(`${API_ENDPOINT.MONITOR_EXECUTIONS}?${query.toString()}`, {
    method: 'GET',
  });
}

export async function startMonitorExecution(executionId) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(
    `${API_ENDPOINT.MONITOR_EXECUTIONS}/${encodeURIComponent(executionId)}/start`,
    {
      body: {
        code: authCodeResult.code,
      },
    }
  );
}

export async function finishMonitorExecution(executionId, result = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(
    `${API_ENDPOINT.MONITOR_EXECUTIONS}/${encodeURIComponent(executionId)}/finish`,
    {
      body: {
        code: authCodeResult.code,
        ...result,
      },
    }
  );
}

export async function getMonitorSettings() {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const query = new URLSearchParams({
    code: authCodeResult.code,
  });

  return await request(`${API_ENDPOINT.MONITOR_SETTINGS}?${query.toString()}`, {
    method: 'GET',
  });
}

export async function saveMonitorSettings(settings = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.MONITOR_SETTINGS, {
    method: 'PUT',
    body: {
      code: authCodeResult.code,
      settings,
    },
  });
}

export async function updateMonitorSubscription(subscriptionId, updates = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(
    `${API_ENDPOINT.MONITOR_SUBSCRIPTIONS}/${encodeURIComponent(subscriptionId)}`,
    {
      method: 'PATCH',
      body: {
        code: authCodeResult.code,
        ...updates,
      },
    }
  );
}

export async function listMonitorHits({ subscriptionId = '', limit = 50 } = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const query = new URLSearchParams({
    code: authCodeResult.code,
    limit: String(limit),
  });

  if (subscriptionId) {
    query.set('subscriptionId', subscriptionId);
  }

  return await request(`${API_ENDPOINT.MONITOR_HITS}?${query.toString()}`, {
    method: 'GET',
  });
}

export async function runMonitorNow({
  platform = '',
  subjectType = 'creator',
  limit,
} = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  const body = {
    code: authCodeResult.code,
  };

  if (platform) {
    body.platform = platform;
  }
  body.subjectType =
    normalizeMonitorSubscriptionText(subjectType).toLowerCase() === 'official'
      ? 'official'
      : 'creator';
  if (Number.isInteger(limit) && limit > 0) {
    body.limit = limit;
  }

  return await request(API_ENDPOINT.MONITOR_RUN_NOW, {
    body,
    timeout: DEFAULT_CONFIG.MONITOR_RUN_NOW_TIMEOUT,
  });
}

// ==================== 辅助函数 ====================

/**
 * 检查 target 配置是否完整
 */
export function isTargetConfigured(target) {
  if (!target || typeof target !== 'object') {
    return false;
  }

  return !!(
    target.feishuAppToken &&
    (
      target.tableId ||
      target.keywordNotesTableName ||
      target.bloggerProfileTableName ||
      target.bloggerNotesTableName ||
      target.commentLeadsTableName ||
      target.monitorTableName
    )
  );
}

/**
 * 验证 payload 基本结构
 */
export function validatePayload(syncType, payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, reason: 'Invalid payload structure' };
  }

  // 检查必填字段
  const requiredFields = {
    single_note: ['url', 'title', 'author', 'content'],
    blogger_profile: ['bloggerName', 'bloggerUrl'],
    blogger_notes: ['bloggerUrl', 'items'],
    keyword_notes: ['keyword', 'items'],
    comments: ['noteUrl', 'items'],
    comment_leads: ['noteUrl', 'items'],
  };

  const required = requiredFields[syncType];
  if (!required) {
    return { valid: false, reason: 'Unknown syncType' };
  }

  for (const field of required) {
    if (!(field in payload)) {
      return { valid: false, reason: `Missing field: ${field}` };
    }
  }

  if (
    syncType === 'single_note' &&
    !('lastEditedAt' in payload) &&
    !('publishDate' in payload)
  ) {
    return { valid: false, reason: 'Missing field: lastEditedAt' };
  }

  return { valid: true };
}
