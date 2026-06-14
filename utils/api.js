/**
 * OnStarVoice V1.0 API Layer
 * 封装与后端的通信，统一处理请求和响应
 */

import { API_ENDPOINT, ERROR_REASON, DEFAULT_CONFIG } from './constants.js';
import { getAuth, getRuntime } from './storage.js';
import { ensurePlainAuthCode } from './auth-code.js';
import { appendTaskContext } from './task-context.js';
import { recordDiagnosticError } from './diagnostics.js';

// ==================== 配置 ====================

const API_BASE_URLS = [
  globalThis.__ONSTARVOICE_API_BASE_URL__,
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'https://voice.minilife.online',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

let activeApiBaseUrl = API_BASE_URLS[0];

// ==================== 通用请求函数 ====================

/**
 * 统一请求函数
 */
async function request(endpoint, options = {}) {
  const {
    method = 'POST',
    body = null,
    timeout = DEFAULT_CONFIG.REQUEST_TIMEOUT,
  } = options;

  const baseUrls = [activeApiBaseUrl, ...API_BASE_URLS.filter(base => base !== activeApiBaseUrl)];
  let lastNetworkError = null;

  for (const baseUrl of baseUrls) {
    const result = await requestOnce(baseUrl, endpoint, { method, body, timeout });
    if (!result?.__networkError) {
      activeApiBaseUrl = baseUrl;
      return result;
    }
    lastNetworkError = result;
  }

  return lastNetworkError;
}

async function requestOnce(baseUrl, endpoint, options = {}) {
  const {
    method = 'POST',
    body = null,
    timeout = DEFAULT_CONFIG.REQUEST_TIMEOUT,
  } = options;

  const url = `${baseUrl}${endpoint}`;
  const requestBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? appendTaskContext(body)
      : body;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: requestBody ? JSON.stringify(requestBody) : null,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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
      };
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
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
export async function sync({ syncType, target, payload }) {
  const runtime = await getRuntime();
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
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

  return await request(API_ENDPOINT.SYNC, { body });
}

// ==================== 批量同步 ====================

/**
 * 批量同步多条记录
 * @param {Array<Object>} records - 记录列表（{ id, type, payload }）
 * @param {Object} target - 同步目标配置
 * @returns {Promise<Object>} 批量同步结果
 */
export async function syncBatch(records, target) {
  const runtime = await getRuntime();
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
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

  return await request(API_ENDPOINT.SYNC_BATCH, { body });
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

export async function createMonitorSubscription(input = {}) {
  const authCodeResult = await resolvePlainAuthCodeFromCurrentAuth();
  if (!authCodeResult.ok) {
    return authCodeResult;
  }

  return await request(API_ENDPOINT.MONITOR_SUBSCRIPTIONS, {
    body: {
      code: authCodeResult.code,
      ...input,
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

export async function runMonitorNow({ platform = '', limit } = {}) {
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
