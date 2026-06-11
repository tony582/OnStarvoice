/**
 * OnStarVoice V1.0 Storage Layer
 * 统一封装本地存储
 * 禁止业务层直接操作 chrome.storage
 */

import {
  STORAGE_KEY,
  AUTH_STATUS,
  CAPTURE_STATUS,
  SYNC_STATUS,
  RECORD_STATUS,
  ERROR_REASON,
  PAGE_TYPE,
} from "./constants.js";
import {
  normalizeStoredRecord,
  serializeRecordEnvelope,
} from "./platform/record-envelope.js";

// ==================== 辅助函数 ====================

/**
 * 通用读取函数
 */
async function getItem(key) {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  } catch (error) {
    console.error(`[Storage] Failed to get ${key}:`, error);
    return null;
  }
}

/**
 * 通用写入函数
 */
async function setItem(key, value) {
  try {
    await chrome.storage.local.set({[key]: value});
    return true;
  } catch (error) {
    console.error(`[Storage] Failed to set ${key}:`, error);
    return false;
  }
}

/**
 * 通用删除函数
 */
async function removeItem(key) {
  try {
    await chrome.storage.local.remove(key);
    return true;
  } catch (error) {
    console.error(`[Storage] Failed to remove ${key}:`, error);
    return false;
  }
}

// ==================== Runtime 状态 ====================

/**
 * 获取 runtime 状态
 */
export async function getRuntime() {
  const runtime = await getItem(STORAGE_KEY.RUNTIME);
  return {
    ...getDefaultRuntime(),
    ...(runtime || {}),
  };
}

/**
 * 设置 runtime 状态
 */
export async function setRuntime(runtime) {
  return await setItem(STORAGE_KEY.RUNTIME, {
    ...runtime,
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 更新 runtime 部分字段
 */
export async function updateRuntime(updates) {
  const current = await getRuntime();
  return await setRuntime({...current, ...updates});
}

/**
 * 默认 runtime 状态
 */
function getDefaultRuntime() {
  return {
    platform: "unknown",
    pageType: PAGE_TYPE.UNKNOWN,
    clientUuid: "",
    clientLabel: "",
    appVersion: "2.0.0",
    lastActiveTabId: null,
    lastPageUrl: "",
    lastUpdatedAt: Date.now(),
  };
}

// ==================== Auth 状态 ====================

/**
 * 获取 auth 状态
 */
export async function getAuth() {
  const auth = await getItem(STORAGE_KEY.AUTH);
  return auth || getDefaultAuth();
}

/**
 * 设置 auth 状态
 */
export async function setAuth(auth) {
  return await setItem(STORAGE_KEY.AUTH, auth);
}

/**
 * 更新 auth 部分字段
 */
export async function updateAuth(updates) {
  const current = await getAuth();
  return await setAuth({...current, ...updates});
}

/**
 * 清除 auth 状态
 */
export async function clearAuth() {
  return await setAuth(getDefaultAuth());
}

/**
 * 默认 auth 状态
 */
function getDefaultAuth() {
  return {
    code: "",
    status: AUTH_STATUS.IDLE,
    lastVerifiedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    reason: ERROR_REASON.NONE,
    message: "",
    user: null,
    credentialCredit: null,
    credential: null,
    binding: null,
    tenant: null,
  };
}

// ==================== Target 配置 ====================

/**
 * 获取 target 配置
 */
export async function getTarget() {
  const target = await getItem(STORAGE_KEY.TARGET);
  return normalizeTargetConfig(target || getDefaultTarget());
}

/**
 * 设置 target 配置
 */
export async function setTarget(target) {
  return await setItem(
    STORAGE_KEY.TARGET,
    {
      ...normalizeTargetConfig(target),
      lastSavedAt: Date.now(),
    },
  );
}

/**
 * 更新 target 部分字段
 */
export async function updateTarget(updates) {
  const current = await getTarget();
  return await setTarget({...current, ...updates});
}

/**
 * 默认 target 配置
 */
function normalizeTargetString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isIgnoredTargetPlaceholder(value) {
  const normalized = normalizeTargetString(value).toLowerCase();
  return (
    normalized === "https://test.url" ||
    normalized === "http://test.url" ||
    normalized === "test.url" ||
    normalized === "test_table"
  );
}

function normalizeTargetConfig(target) {
  const source =
    target && typeof target === "object" && !Array.isArray(target)
      ? target
      : {};
  const feishuAppToken = normalizeTargetString(source.feishuAppToken);
  const tableId = normalizeTargetString(source.tableId);

  return {
    feishuAppToken: isIgnoredTargetPlaceholder(feishuAppToken)
      ? ""
      : feishuAppToken,
    tableId: isIgnoredTargetPlaceholder(tableId)
      ? "单笔记采集"
      : tableId || "单笔记采集",
    bloggerProfileTableName:
      normalizeTargetString(source.bloggerProfileTableName) || "博主信息表",
    bloggerNotesTableName:
      normalizeTargetString(source.bloggerNotesTableName) || "博主笔记采集",
    keywordNotesTableName:
      normalizeTargetString(source.keywordNotesTableName) || "关键词笔记采集",
    commentLeadsTableName:
      normalizeTargetString(source.commentLeadsTableName) || "评论区客资采集",
    reportWebhookUrl: normalizeTargetString(source.reportWebhookUrl),
    balanceAlertWebhookUrl: normalizeTargetString(source.balanceAlertWebhookUrl),
    viewId: normalizeTargetString(source.viewId),
    monitorTableName:
      normalizeTargetString(source.monitorTableName) || "监控内容表",
    isConfigured: source.isConfigured === true,
    lastSavedAt:
      typeof source.lastSavedAt === "number" &&
      Number.isFinite(source.lastSavedAt)
        ? source.lastSavedAt
        : null,
  };
}

function getDefaultTarget() {
  return normalizeTargetConfig({
    feishuAppToken: "",
    tableId: "单笔记采集",
    reportWebhookUrl: "",
    isConfigured: false,
    lastSavedAt: null,
  });
}

// ==================== Capture 状态 ====================

/**
 * 获取 capture 状态
 */
export async function getCapture() {
  const capture = await getItem(STORAGE_KEY.CAPTURE);
  return capture || getDefaultCapture();
}

/**
 * 设置 capture 状态
 */
export async function setCapture(capture) {
  return await setItem(STORAGE_KEY.CAPTURE, capture);
}

/**
 * 更新 capture 部分字段
 */
export async function updateCapture(updates) {
  const current = await getCapture();
  return await setCapture({...current, ...updates});
}

/**
 * 重置 capture 状态
 */
export async function resetCapture() {
  return await setCapture(getDefaultCapture());
}

/**
 * 默认 capture 状态
 */
function getDefaultCapture() {
  return {
    status: CAPTURE_STATUS.IDLE,
    activeType: null,
    progress: {
      phase: "idle",
      percent: 0,
      message: "",
    },
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

// ==================== Sync 状态 ====================

/**
 * 获取 sync 状态
 */
export async function getSync() {
  const sync = await getItem(STORAGE_KEY.SYNC);
  return sync || getDefaultSync();
}

/**
 * 设置 sync 状态
 */
export async function setSync(sync) {
  return await setItem(STORAGE_KEY.SYNC, sync);
}

/**
 * 更新 sync 部分字段
 */
export async function updateSync(updates) {
  const current = await getSync();
  return await setSync({...current, ...updates});
}

/**
 * 重置 sync 状态
 */
export async function resetSync() {
  return await setSync(getDefaultSync());
}

/**
 * 默认 sync 状态
 */
function getDefaultSync() {
  return {
    status: SYNC_STATUS.IDLE,
    activeSyncType: null,
    activeRecordIds: [],
    startedAt: null,
    finishedAt: null,
    reason: ERROR_REASON.NONE,
    message: "",
    error: null,
  };
}

// ==================== Monitor 状态 ====================

/**
 * 获取 monitor 状态
 */
export async function getMonitor() {
  const monitor = await getItem(STORAGE_KEY.MONITOR);
  return monitor || getDefaultMonitor();
}

/**
 * 设置 monitor 状态
 */
export async function setMonitor(monitor) {
  return await setItem(STORAGE_KEY.MONITOR, {
    ...monitor,
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 更新 monitor 部分字段
 */
export async function updateMonitor(updates) {
  const current = await getMonitor();
  return await setMonitor({...current, ...updates});
}

/**
 * 重置 monitor 状态
 */
export async function resetMonitor() {
  return await setMonitor(getDefaultMonitor());
}

/**
 * 默认 monitor 状态
 */
function getDefaultMonitor() {
  return {
    items: [],
    executions: [],
    settings: {
      publishWindow: "previous_day",
      likeThreshold: 0,
      runTimes: ["10:00"],
      observeWindowHours: 48,
      timezone: "Asia/Shanghai",
    },
    filters: {
      status: "all",
    },
    isLoading: false,
    isSaving: false,
    isSavingSettings: false,
    isLoadingExecutions: false,
    error: null,
    executionsError: null,
    lastFetchedAt: null,
    executionsLastFetchedAt: null,
    lastUpdatedAt: null,
  };
}

// ==================== Data Pool ====================

/**
 * 获取数据池
 */
export async function getDataPool() {
  const dataPool = await getItem(STORAGE_KEY.DATA_POOL);
  const nextDataPool = dataPool || getDefaultDataPool();
  const normalizedRecords = Array.isArray(nextDataPool.records)
    ? nextDataPool.records.map((record) => normalizeStoredRecord(record))
    : [];
  const repairedRecords = repairDuplicateRecordIds(normalizedRecords);
  const changed =
    repairedRecords.length !== normalizedRecords.length ||
    repairedRecords.some(
      (record, index) => record.id !== normalizedRecords[index]?.id,
    );

  if (changed) {
    const repairedPool = {
      ...nextDataPool,
      records: repairedRecords.map((record) => serializeRecordEnvelope(record)),
      lastUpdatedAt: Date.now(),
    };
    await setItem(STORAGE_KEY.DATA_POOL, repairedPool);
    return {
      ...repairedPool,
      records: repairedRecords,
    };
  }

  return {
    ...nextDataPool,
    records: normalizedRecords,
  };
}

/**
 * 设置数据池
 */
export async function setDataPool(dataPool) {
  return await setItem(STORAGE_KEY.DATA_POOL, {
    ...dataPool,
    records: Array.isArray(dataPool?.records)
      ? dataPool.records.map((record) => serializeRecordEnvelope(record))
      : [],
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 默认数据池
 */
function getDefaultDataPool() {
  return {
    records: [],
    filters: {
      type: "all",
      status: "all",
    },
    lastUpdatedAt: null,
  };
}

// ==================== Sync History ====================

/**
 * 获取同步历史
 */
export async function getSyncHistory() {
  const syncHistory = await getItem(STORAGE_KEY.SYNC_HISTORY);
  return syncHistory || getDefaultSyncHistory();
}

/**
 * 设置同步历史
 */
export async function setSyncHistory(syncHistory) {
  return await setItem(STORAGE_KEY.SYNC_HISTORY, {
    ...syncHistory,
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 添加同步历史记录（按批次）
 */
export async function addSyncHistoryEntry(entry) {
  const syncHistory = await getSyncHistory();
  const newEntry = {
    id: generateSyncHistoryId(),
    createdAt: Date.now(),
    ...entry,
  };

  syncHistory.entries = [newEntry, ...(syncHistory.entries || [])].slice(
    0,
    200,
  );
  await setSyncHistory(syncHistory);
  return newEntry;
}

/**
 * 清空同步历史
 */
export async function clearSyncHistory() {
  await setItem(STORAGE_KEY.SYNC_HISTORY, {
    entries: [],
    lastUpdatedAt: Date.now(),
  });
  return true;
}

/**
 * 默认同步历史
 */
function getDefaultSyncHistory() {
  return {
    entries: [],
    lastUpdatedAt: null,
  };
}

// ==================== Data Pool Records ====================

/**
 * 添加记录到数据池
 */
export async function addRecord(record) {
  const dataPool = await getDataPool();
  const newRecord = normalizeStoredRecord({
    id: record?.id || generateRecordId(),
    ...record,
    status: record?.status || RECORD_STATUS.DRAFT,
    createdAt: record?.createdAt || Date.now(),
    updatedAt: Date.now(),
    lastSyncedAt: record?.lastSyncedAt || null,
    lastSyncReason: record?.lastSyncReason || ERROR_REASON.NONE,
    lastSyncDebugUrl: record?.lastSyncDebugUrl || null,
  });

  dataPool.records.unshift(newRecord);
  const saved = await setDataPool(dataPool);
  if (!saved) {
    throw new Error("本地缓存写入失败，请检查扩展存储空间或稍后重试");
  }
  return newRecord;
}

/**
 * 批量添加记录
 */
export async function addRecords(records) {
  const dataPool = await getDataPool();
  const newRecords = records.map((record) =>
    normalizeStoredRecord({
      id: record?.id || generateRecordId(),
      ...record,
      status: record?.status || RECORD_STATUS.DRAFT,
      createdAt: record?.createdAt || Date.now(),
      updatedAt: Date.now(),
      lastSyncedAt: record?.lastSyncedAt || null,
      lastSyncReason: record?.lastSyncReason || ERROR_REASON.NONE,
      lastSyncDebugUrl: record?.lastSyncDebugUrl || null,
    }),
  );

  dataPool.records.unshift(...newRecords);
  const saved = await setDataPool(dataPool);
  if (!saved) {
    throw new Error("本地缓存写入失败，请检查扩展存储空间或稍后重试");
  }
  return newRecords;
}

/**
 * 更新记录
 */
export async function updateRecord(recordId, updates) {
  const dataPool = await getDataPool();
  const index = dataPool.records.findIndex((r) => r.id === recordId);

  if (index === -1) {
    console.error(`[Storage] Record not found: ${recordId}`);
    return false;
  }

  const normalizedUpdates = normalizeRecordUpdates(updates);
  dataPool.records[index] = {
    ...dataPool.records[index],
    ...normalizedUpdates,
    updatedAt: Date.now(),
  };
  dataPool.records[index] = normalizeStoredRecord(dataPool.records[index]);

  await setDataPool(dataPool);
  return true;
}

/**
 * 删除记录
 */
export async function deleteRecord(recordId) {
  const dataPool = await getDataPool();
  dataPool.records = dataPool.records.filter((r) => r.id !== recordId);
  await setDataPool(dataPool);
  return true;
}

/**
 * 批量删除记录
 */
export async function deleteRecords(recordIds) {
  const dataPool = await getDataPool();
  const idsSet = new Set(recordIds);
  dataPool.records = dataPool.records.filter((r) => !idsSet.has(r.id));
  await setDataPool(dataPool);
  return true;
}

/**
 * 清空所有记录
 */
export async function clearAllRecords() {
  const dataPool = await getDataPool();
  dataPool.records = [];
  await setDataPool(dataPool);
  return true;
}

/**
 * 清空已同步记录
 */
export async function clearSyncedRecords() {
  const dataPool = await getDataPool();
  dataPool.records = dataPool.records.filter(
    (r) => r.status !== RECORD_STATUS.SYNCED,
  );
  await setDataPool(dataPool);
  return true;
}

/**
 * 获取单条记录
 */
export async function getRecord(recordId) {
  const dataPool = await getDataPool();
  return dataPool.records.find((r) => r.id === recordId) || null;
}

/**
 * 获取多条记录
 */
export async function getRecords(recordIds) {
  const dataPool = await getDataPool();
  const idsSet = new Set(recordIds);
  return dataPool.records.filter((r) => idsSet.has(r.id));
}

/**
 * 筛选记录
 */
export async function filterRecords({type, status}) {
  const dataPool = await getDataPool();
  let filtered = dataPool.records;

  if (type && type !== "all") {
    filtered = filtered.filter((r) => r.type === type || r.recordType === type);
  }

  if (status && status !== "all") {
    filtered = filtered.filter((r) => r.status === status);
  }

  return filtered;
}

/**
 * 标记记录为已同步
 */
export async function markRecordSynced(recordId, debugUrl = null) {
  return await updateRecord(recordId, {
    status: RECORD_STATUS.SYNCED,
    lastSyncedAt: Date.now(),
    lastSyncReason: ERROR_REASON.NONE,
    lastSyncDebugUrl: debugUrl || null,
  });
}

/**
 * 标记记录为同步失败
 */
export async function markRecordFailed(
  recordId,
  reason,
  message,
  debugUrl = null,
) {
  return await updateRecord(recordId, {
    status: RECORD_STATUS.FAILED,
    lastSyncedAt: Date.now(),
    lastSyncReason: reason,
    lastSyncDebugUrl: debugUrl || null,
  });
}

/**
 * 生成记录 ID
 */
function generateRecordId() {
  return `rec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function repairDuplicateRecordIds(records = []) {
  if (!Array.isArray(records) || records.length <= 1) {
    return Array.isArray(records) ? records : [];
  }

  const usedIds = new Set();

  return records.map((record) => {
    const normalizedRecord = record && typeof record === "object" ? record : {};
    let nextId = String(normalizedRecord.id || "").trim();
    if (!nextId || usedIds.has(nextId)) {
      nextId = generateRecordId();
      while (usedIds.has(nextId)) {
        nextId = generateRecordId();
      }
    }
    usedIds.add(nextId);
    if (nextId === normalizedRecord.id) {
      return normalizedRecord;
    }
    return {
      ...normalizedRecord,
      id: nextId,
    };
  });
}

function normalizeRecordUpdates(updates = {}) {
  if (!updates || typeof updates !== "object") {
    return {};
  }

  const nextUpdates = {...updates};

  if (Object.prototype.hasOwnProperty.call(nextUpdates, "type")) {
    nextUpdates.recordType = nextUpdates.type;
    delete nextUpdates.type;
  }

  if (Object.prototype.hasOwnProperty.call(nextUpdates, "payload")) {
    nextUpdates.normalizedPayload = nextUpdates.payload;
    delete nextUpdates.payload;
  }

  return nextUpdates;
}

// ==================== 完整清理 ====================

/**
 * 清空数据池（保留其他状态）
 */
export async function clearDataPool() {
  await setItem(STORAGE_KEY.DATA_POOL, {
    records: [],
    filters: {
      type: "all",
      status: "all",
    },
    lastUpdatedAt: Date.now(),
  });
}

/**
 * 清除所有数据（用于测试或重置）
 */
export async function clearAll() {
  await removeItem(STORAGE_KEY.RUNTIME);
  await removeItem(STORAGE_KEY.AUTH);
  await removeItem(STORAGE_KEY.TARGET);
  await removeItem(STORAGE_KEY.CAPTURE);
  await removeItem(STORAGE_KEY.SYNC);
  await removeItem(STORAGE_KEY.MONITOR);
  await removeItem(STORAGE_KEY.DATA_POOL);
  await removeItem(STORAGE_KEY.SYNC_HISTORY);
  return true;
}

function generateSyncHistoryId() {
  return `sync_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
