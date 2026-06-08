/**
 * onstarvoice V2.0 Sidebar State Management
 * 侧边栏状态管理，统一管理UI状态
 * 基于 state-schema.md
 */

import {
  getRuntime,
  getAuth,
  getTarget,
  getCapture,
  getSync,
  getMonitor,
  getDataPool,
  getSyncHistory,
  updateRuntime,
  updateAuth,
  updateCapture,
  updateSync,
  updateMonitor,
} from '../utils/storage.js';

import { detectPageType } from '../utils/helpers.js';
import {
  detectPlatformFromUrl,
  isSupportedCaptureUrl,
} from '../utils/platform/page-routing.js';
import { STORAGE_KEY, MESSAGE_TYPE } from '../utils/constants.js';

// ==================== 状态订阅系统 ====================

const stateListeners = new Map();
let storageListenerBound = false;

/**
 * 订阅状态变化
 */
export function subscribe(key, callback) {
  if (!stateListeners.has(key)) {
    stateListeners.set(key, new Set());
  }
  stateListeners.get(key).add(callback);

  // 返回取消订阅函数
  return () => {
    const listeners = stateListeners.get(key);
    if (listeners) {
      listeners.delete(callback);
    }
  };
}

/**
 * 通知状态变化
 */
function notifyListeners(key, newState) {
  const listeners = stateListeners.get(key);
  if (listeners) {
    listeners.forEach((callback) => callback(newState));
  }
}

function bindStorageListeners() {
  if (storageListenerBound) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }

    const runtimeChange = changes[STORAGE_KEY.RUNTIME];
    if (!runtimeChange || !runtimeChange.newValue) {
      return;
    }

    currentRuntime = runtimeChange.newValue;
    notifyListeners('runtime', currentRuntime);
  });

  storageListenerBound = true;
}

// ==================== 运行时状态 ====================

let currentRuntime = null;

async function fetchRuntimeFromBackground() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.GET_EXTENSION_STATE,
    });
    if (response?.ok && response?.data && typeof response.data === "object") {
      return response.data;
    }
  } catch (error) {
    console.warn("[State] failed to fetch runtime from background:", error);
  }
  return null;
}

async function getPreferredRuntimeTab(runtime) {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id && isSupportedCaptureUrl(tab.url || "")) {
      return tab;
    }
  } catch {
    // ignore and fallback
  }

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id && isSupportedCaptureUrl(tab.url || "")) {
      return tab;
    }
  } catch {
    // ignore
  }

  const preferredTabId = Number(runtime?.lastActiveTabId);
  if (Number.isFinite(preferredTabId) && preferredTabId > 0) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab?.id) {
        return tab;
      }
    } catch {
      // ignore and fallback
    }
  }

  return null;
}

/**
 * 初始化运行时状态
 */
export async function initRuntime() {
  const storedRuntime = await getRuntime();
  const backgroundRuntime = await fetchRuntimeFromBackground();
  currentRuntime = {
    ...storedRuntime,
    ...(backgroundRuntime || {}),
  };

  const tab = await getPreferredRuntimeTab(currentRuntime);
  if (tab?.id && isSupportedCaptureUrl(tab.url || "")) {
    const pageType = await detectPageTypeForTab(tab);
    const platform = detectPlatformFromUrl(tab.url || "");
    currentRuntime = {
      ...currentRuntime,
      platform,
      pageType,
      lastActiveTabId: tab.id,
      lastPageUrl: tab.url || "",
    };
    await updateRuntime({
      platform,
      pageType,
      lastActiveTabId: tab.id,
      lastPageUrl: tab.url || "",
    });
  }

  notifyListeners("runtime", currentRuntime);
  return currentRuntime;
}

async function detectPageTypeForTab(tab) {
  const fallbackPageType = detectPageType(tab?.url || '');

  if (!tab?.id || !isSupportedCaptureUrl(tab.url)) {
    return fallbackPageType;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE.RELAY_TO_CONTENT,
      tabId: tab.id,
      payload: {
        action: 'detectPageType',
      },
    });

    const pageType = response?.data?.pageType;
    if (response?.ok && response?.data?.ok && typeof pageType === 'string') {
      return pageType;
    }
  } catch (error) {
    console.warn('[State] detect page type from content failed:', error);
  }

  return fallbackPageType;
}

/**
 * 获取当前运行时状态
 */
export function getCurrentRuntime() {
  return currentRuntime;
}

/**
 * 更新运行时状态
 */
export async function setCurrentRuntime(updates) {
  currentRuntime = { ...currentRuntime, ...updates };
  await updateRuntime(updates);
  notifyListeners('runtime', currentRuntime);
}

// ==================== 鉴权状态 ====================

let currentAuth = null;

/**
 * 初始化鉴权状态
 */
export async function initAuth() {
  currentAuth = await getAuth();
  notifyListeners('auth', currentAuth);
  return currentAuth;
}

/**
 * 获取当前鉴权状态
 */
export function getCurrentAuth() {
  return currentAuth;
}

/**
 * 刷新鉴权状态
 */
export async function refreshAuth() {
  currentAuth = await getAuth();
  notifyListeners('auth', currentAuth);
  return currentAuth;
}

/**
 * 更新鉴权状态
 */
export async function setCurrentAuth(updates) {
  currentAuth = { ...currentAuth, ...updates };
  await updateAuth(updates);
  notifyListeners('auth', currentAuth);
}

// ==================== 目标配置 ====================

let currentTarget = null;

/**
 * 初始化目标配置
 */
export async function initTarget() {
  currentTarget = await getTarget();
  notifyListeners('target', currentTarget);
  return currentTarget;
}

/**
 * 获取当前目标配置
 */
export function getCurrentTarget() {
  return currentTarget;
}

/**
 * 更新目标配置
 */
export async function setCurrentTarget(updates) {
  const { setTarget } = await import('../utils/storage.js');
  currentTarget = { ...currentTarget, ...updates };
  await setTarget(currentTarget);
  notifyListeners('target', currentTarget);
}

// ==================== 采集状态 ====================

let currentCapture = null;

/**
 * 初始化采集状态
 */
export async function initCapture() {
  currentCapture = await getCapture();
  notifyListeners('capture', currentCapture);
  return currentCapture;
}

/**
 * 获取当前采集状态
 */
export function getCurrentCapture() {
  return currentCapture;
}

/**
 * 更新采集状态
 */
export async function setCurrentCapture(updates) {
  currentCapture = { ...currentCapture, ...updates };
  await updateCapture(updates);
  notifyListeners('capture', currentCapture);
}

/**
 * 重置采集状态
 */
export async function resetCurrentCapture() {
  const { resetCapture } = await import('../utils/storage.js');
  await resetCapture();
  currentCapture = await getCapture();
  notifyListeners('capture', currentCapture);
}

// ==================== 同步状态 ====================

let currentSync = null;

/**
 * 初始化同步状态
 */
export async function initSync() {
  currentSync = await getSync();
  notifyListeners('sync', currentSync);
  return currentSync;
}

/**
 * 获取当前同步状态
 */
export function getCurrentSync() {
  return currentSync;
}

/**
 * 更新同步状态
 */
export async function setCurrentSync(updates) {
  currentSync = { ...currentSync, ...updates };
  await updateSync(updates);
  notifyListeners('sync', currentSync);
}

/**
 * 重置同步状态
 */
export async function resetCurrentSync() {
  const { resetSync } = await import('../utils/storage.js');
  await resetSync();
  currentSync = await getSync();
  notifyListeners('sync', currentSync);
}

// ==================== 监控状态 ====================

let currentMonitor = null;

/**
 * 初始化监控状态
 */
export async function initMonitor() {
  currentMonitor = await getMonitor();
  notifyListeners('monitor', currentMonitor);
  return currentMonitor;
}

/**
 * 获取当前监控状态
 */
export function getCurrentMonitor() {
  return currentMonitor;
}

/**
 * 刷新监控状态
 */
export async function refreshMonitor() {
  currentMonitor = await getMonitor();
  notifyListeners('monitor', currentMonitor);
  return currentMonitor;
}

/**
 * 更新监控状态
 */
export async function setCurrentMonitor(updates) {
  currentMonitor = { ...currentMonitor, ...updates };
  await updateMonitor(updates);
  notifyListeners('monitor', currentMonitor);
}

/**
 * 重置监控状态
 */
export async function resetCurrentMonitor() {
  const { resetMonitor } = await import('../utils/storage.js');
  await resetMonitor();
  currentMonitor = await getMonitor();
  notifyListeners('monitor', currentMonitor);
}

// ==================== 数据池状态 ====================

let currentDataPool = null;

/**
 * 初始化数据池
 */
export async function initDataPool() {
  currentDataPool = await getDataPool();
  notifyListeners('dataPool', currentDataPool);
  return currentDataPool;
}

/**
 * 获取当前数据池
 */
export function getCurrentDataPool() {
  return currentDataPool;
}

/**
 * 刷新数据池
 */
export async function refreshDataPool() {
  currentDataPool = await getDataPool();
  notifyListeners('dataPool', currentDataPool);
  return currentDataPool;
}

// ==================== 同步历史状态 ====================

let currentSyncHistory = null;

/**
 * 初始化同步历史
 */
export async function initSyncHistory() {
  currentSyncHistory = await getSyncHistory();
  notifyListeners('syncHistory', currentSyncHistory);
  return currentSyncHistory;
}

/**
 * 获取当前同步历史
 */
export function getCurrentSyncHistory() {
  return currentSyncHistory;
}

/**
 * 刷新同步历史
 */
export async function refreshSyncHistory() {
  currentSyncHistory = await getSyncHistory();
  notifyListeners('syncHistory', currentSyncHistory);
  return currentSyncHistory;
}

// ==================== 全量初始化 ====================

/**
 * 初始化所有状态
 */
export async function initAllStates() {
  bindStorageListeners();

  await Promise.all([
    initRuntime(),
    initAuth(),
    initTarget(),
    initCapture(),
    initSync(),
    initMonitor(),
    initDataPool(),
    initSyncHistory(),
  ]);
}

// ==================== 状态快照 ====================

/**
 * 获取所有状态的快照
 */
export function getStateSnapshot() {
  return {
    runtime: currentRuntime,
    auth: currentAuth,
    target: currentTarget,
    capture: currentCapture,
    sync: currentSync,
    monitor: currentMonitor,
    dataPool: currentDataPool,
    syncHistory: currentSyncHistory,
  };
}
