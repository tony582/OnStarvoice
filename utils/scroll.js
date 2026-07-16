/**
 * onstarvoice V2.0 Scroll & Wait Mechanism
 * 封装拟人化滚动与等待机制
 *
 * 设计原则：
 * 1. 模拟人类滚动行为，避免被反爬检测
 * 2. 随机延迟，避免固定模式
 * 3. 支持取消操作
 * 4. 提供进度回调
 */

import { randomScrollDistance } from './helpers.js';
import { DEFAULT_CONFIG } from './constants.js';

// ==================== 取消控制器 ====================

let cancelFlag = false;

const SMOOTH_SCROLL_FALLBACK_MIN_MS = 1500;
const SMOOTH_SCROLL_FALLBACK_PADDING_MS = 1000;
const CAPTURE_STEP_TIMEOUT_MS = 30 * 1000;
const NETWORK_HEARTBEAT_INTERVAL_MS = 5000;
const CAPTURE_SUSPEND_GAP_MS = 15 * 1000;
// MV3 后台消息通道不适合无限等待。短断网自动续，长断网主动收口为
// partial/failed，交给持久化的 ↻ 入口继续，避免再次出现 Forever。
const NETWORK_PAUSE_MAX_MS = 2 * 60 * 1000;

/**
 * 设置取消标志
 */
export function setCancelFlag(value = true) {
  cancelFlag = value;
}

/**
 * 检查是否已取消
 */
export function isCanceled() {
  return cancelFlag;
}

/**
 * 重置取消标志
 */
export function resetCancelFlag() {
  cancelFlag = false;
}

// ==================== 滚动函数 ====================

/**
 * 平滑滚动到指定位置
 * @param {number} targetY - 目标 Y 坐标
 * @param {number} duration - 滚动持续时间（毫秒）
 * @returns {Promise<void>}
 */
export async function smoothScrollTo(targetY, duration = 500) {
  const normalizedTargetY = Number.isFinite(Number(targetY))
    ? Number(targetY)
    : Number(window.scrollY) || 0;
  const normalizedDuration = Math.max(0, Number(duration) || 0);

  // requestAnimationFrame 会在后台标签页、合盖休眠或页面冻结时暂停。
  // 隐藏页直接落点，避免采集 Promise 永远等不到下一帧。
  if (normalizedDuration <= 0 || document.hidden) {
    window.scrollTo(0, normalizedTargetY);
    return;
  }

  return new Promise((resolve) => {
    const startY = Number(window.scrollY) || 0;
    const distance = normalizedTargetY - startY;
    const startTime = Date.now();
    let frameId = null;
    let fallbackTimer = null;
    let settled = false;

    const finish = ({snapToTarget = true} = {}) => {
      if (settled) return;
      settled = true;
      if (frameId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameId);
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (snapToTarget) {
        window.scrollTo(0, normalizedTargetY);
      }
      resolve();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        finish();
      }
    };

    function scroll() {
      if (isCanceled()) {
        finish({snapToTarget: false});
        return;
      }

      const currentTime = Date.now();
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / normalizedDuration, 1);

      // 缓动函数（easeInOutQuad）
      const easeProgress =
        progress < 0.5
          ? 2 * progress * progress
          : -1 + (4 - 2 * progress) * progress;

      window.scrollTo(0, startY + distance * easeProgress);

      if (progress < 1) {
        frameId = requestAnimationFrame(scroll);
      } else {
        finish();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    fallbackTimer = setTimeout(
      finish,
      Math.max(
        SMOOTH_SCROLL_FALLBACK_MIN_MS,
        normalizedDuration + SMOOTH_SCROLL_FALLBACK_PADDING_MS,
      ),
    );

    try {
      frameId = requestAnimationFrame(scroll);
    } catch {
      finish();
    }
  });
}

/**
 * 滚动到页面底部
 * @param {number} offset - 距离底部的偏移量
 * @returns {Promise<void>}
 */
export async function scrollToBottom(offset = 100) {
  const targetY = document.documentElement.scrollHeight - window.innerHeight - offset;
  await smoothScrollTo(targetY);
}

/**
 * 滚动到页面顶部
 * @returns {Promise<void>}
 */
export async function scrollToTop() {
  await smoothScrollTo(0);
}

/**
 * 随机滚动一段距离
 * @param {number} minDistance - 最小滚动距离
 * @param {number} maxDistance - 最大滚动距离
 * @returns {Promise<void>}
 */
export async function randomScroll(
  minDistance = 300,
  maxDistance = 800
) {
  const distance = randomScrollDistance(minDistance, maxDistance);
  const currentY = window.scrollY;
  const targetY = currentY + distance;
  const maxY = document.documentElement.scrollHeight - window.innerHeight;

  // 确保不超出页面范围
  const finalY = Math.min(targetY, maxY);

  await smoothScrollTo(finalY);
}

// ==================== 等待函数 ====================

/**
 * 等待指定时间（支持取消）
 * @param {number} ms - 等待时间（毫秒）
 * @returns {Promise<void>}
 */
export async function wait(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0 || isCanceled()) return;

  return new Promise((resolve) => {
    const deadline = Date.now() + delay;
    let timer = null;

    const finish = () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve();
    };

    const check = () => {
      if (isCanceled() || Date.now() >= deadline) {
        finish();
        return;
      }
      timer = setTimeout(check, Math.min(100, Math.max(1, deadline - Date.now())));
    };

    timer = setTimeout(check, Math.min(100, delay));
  });
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function waitForNetworkRecovery(onProgress) {
  if (!isOffline()) {
    return {pausedDurationMs: 0, timedOut: false};
  }

  const offlineStartedAt = Date.now();
  while (isOffline() && !isCanceled()) {
    const offlineElapsedMs = Math.max(0, Date.now() - offlineStartedAt);
    if (offlineElapsedMs >= NETWORK_PAUSE_MAX_MS) {
      if (onProgress) {
        onProgress({
          phase: 'network_timeout',
          message: '网络中断超过 2 分钟，已停止当前步骤；恢复联网后可点击 ↻ 继续',
          offlineSince: offlineStartedAt,
          offlineElapsedMs,
        });
      }
      return {pausedDurationMs: offlineElapsedMs, timedOut: true};
    }
    if (onProgress) {
      onProgress({
        phase: 'network_paused',
        message: '网络已断开，采集已暂停；恢复联网后会自动继续当前项',
        offlineSince: offlineStartedAt,
        offlineElapsedMs: Date.now() - offlineStartedAt,
      });
    }
    await wait(NETWORK_HEARTBEAT_INTERVAL_MS);
  }

  if (!isCanceled() && onProgress) {
    onProgress({
      phase: 'network_resumed',
      message: '网络已恢复，正在继续当前项',
      offlineSince: offlineStartedAt,
      offlineElapsedMs: Date.now() - offlineStartedAt,
    });
  }
  return {
    pausedDurationMs: Math.max(0, Date.now() - offlineStartedAt),
    timedOut: false,
  };
}

function createCaptureStepTimeoutError(timeoutMs) {
  const error = new Error(`页面滚动步骤超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应`);
  error.code = 'CAPTURE_STEP_TIMEOUT';
  return error;
}

async function runCaptureStepWithTimeout(step, timeoutMs = CAPTURE_STEP_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(step),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(createCaptureStepTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * 随机等待
 * @param {number} minMs - 最小等待时间
 * @param {number} maxMs - 最大等待时间
 * @returns {Promise<number>} 实际等待毫秒数
 */
export async function randomWait(
  minMs = DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  maxMs = DEFAULT_CONFIG.SCROLL_DELAY_MAX
) {
  const normalizedMin = Number.isFinite(Number(minMs))
    ? Math.max(1, Math.floor(Number(minMs)))
    : DEFAULT_CONFIG.SCROLL_DELAY_MIN;
  const normalizedMax = Number.isFinite(Number(maxMs))
    ? Math.max(1, Math.floor(Number(maxMs)))
    : DEFAULT_CONFIG.SCROLL_DELAY_MAX;
  const lower = Math.min(normalizedMin, normalizedMax);
  const upper = Math.max(normalizedMin, normalizedMax);
  const waitMs = Math.floor(Math.random() * (upper - lower + 1)) + lower;
  await wait(waitMs);
  return waitMs;
}

/**
 * 等待元素出现在视口中
 * @param {Element} element - 目标元素
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
export async function waitForElementInView(element, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!element) {
      reject(new Error('Element is null'));
      return;
    }

    // 检查元素是否已在视口中
    const isInView = () => {
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth
      );
    };

    if (isInView()) {
      resolve();
      return;
    }

    // 使用 IntersectionObserver 监听
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
    });

    observer.observe(element);

    // 超时处理
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Element not in view timeout'));
    }, timeout);
  });
}

/**
 * 等待页面加载完成
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
export async function waitForPageLoad(timeout = 10000) {
  if (document.readyState === 'complete') {
    return;
  }

  return new Promise((resolve, reject) => {
    const onLoad = () => {
      clearTimeout(timer);
      resolve();
    };

    window.addEventListener('load', onLoad, { once: true });

    const timer = setTimeout(() => {
      window.removeEventListener('load', onLoad);
      reject(new Error('Page load timeout'));
    }, timeout);
  });
}

// ==================== 自动滚动加载 ====================

/**
 * 自动滚动加载直到没有新内容
 * @param {Object} options - 配置选项
 * @param {Function} options.onProgress - 进度回调函数
 * @param {Function} options.detectNewContent - 检测新内容的函数
 * @param {number} options.maxScrollTimes - 最大滚动次数
 * @param {number} options.noNewContentThreshold - 连续多少次无新内容后停止
 * @returns {Promise<Object>} 滚动结果
 */
export async function autoScrollLoad({
  onProgress = null,
  detectNewContent = null,
  maxScrollTimes = DEFAULT_CONFIG.MAX_SCROLL_TIMES,
  noNewContentThreshold = DEFAULT_CONFIG.NO_NEW_CONTENT_THRESHOLD,
  maxDurationMs = DEFAULT_CONFIG.MAX_CAPTURE_DURATION_MS,
  waitMinMs = DEFAULT_CONFIG.SCROLL_DELAY_MIN,
  waitMaxMs = DEFAULT_CONFIG.SCROLL_DELAY_MAX,
  scrollStep = null,
  stopWhen = null,
  stepTimeoutMs = CAPTURE_STEP_TIMEOUT_MS,
  resetCancelOnStart = true,
} = {}) {
  let scrollCount = 0;
  let noNewContentCount = 0;
  let previousContentCount = 0;
  let stopReason = '';
  const startedAt = Date.now();
  let pausedDurationMs = 0;
  let lastActiveCheckpointAt = startedAt;
  const getActiveElapsedMs = () =>
    Math.max(0, Date.now() - startedAt - pausedDurationMs);
  const checkpointActiveClock = ({skipGapAccounting = false} = {}) => {
    const now = Date.now();
    const gapMs = Math.max(0, now - lastActiveCheckpointAt);
    lastActiveCheckpointAt = now;
    if (skipGapAccounting || gapMs <= CAPTURE_SUSPEND_GAP_MS) {
      return 0;
    }
    // 正常单步都有独立的 30 秒超时；超过阈值的整段定时器冻结主要来自
    // 合盖、系统休眠或浏览器冻结，不应吞掉用户配置的有效采集时长。
    pausedDurationMs += gapMs;
    noNewContentCount = 0;
    if (onProgress) {
      onProgress({
        phase: 'system_resumed',
        message: '检测到电脑休眠或页面冻结，正在恢复当前采集步骤',
        suspendedDurationMs: gapMs,
        elapsedMs: getActiveElapsedMs(),
      });
    }
    return gapMs;
  };
  const hasFixedNoNewThreshold =
    Number.isFinite(Number(noNewContentThreshold)) &&
    Number(noNewContentThreshold) > 0;

  const shouldStopNow = async ({
    scrollCount,
    currentContentCount,
    noNewContentCount,
  }) => {
    if (typeof stopWhen !== 'function') {
      return false;
    }

    let stopResult = null;
    try {
      stopResult = await stopWhen({
        scrollCount,
        currentContentCount,
        noNewContentCount,
        elapsedMs: getActiveElapsedMs(),
      });
    } catch (error) {
      console.warn('[Scroll] stopWhen callback failed:', error);
    }

    if (!stopResult?.stop) {
      return false;
    }

    stopReason = stopResult.reason || 'custom_stop';
    if (onProgress) {
      onProgress({
        scrollCount,
        phase: stopReason,
        message: stopResult.message || '满足停止条件，结束采集',
        currentContentCount,
        elapsedMs: getActiveElapsedMs(),
      });
    }
    return true;
  };

  // 大多数独立滚动任务由这里初始化取消状态；评论采集在进入本函数前还有
  // DOM 初始化阶段，必须保留用户在那段时间发出的停止信号。
  if (resetCancelOnStart) {
    resetCancelFlag();
  }

  while (scrollCount < maxScrollTimes && !isCanceled()) {
    checkpointActiveClock();
    const beforeScrollNetworkPause = await waitForNetworkRecovery(onProgress);
    pausedDurationMs += beforeScrollNetworkPause.pausedDurationMs;
    checkpointActiveClock({skipGapAccounting: true});
    if (beforeScrollNetworkPause.timedOut) {
      stopReason = 'network_timeout';
      break;
    }
    if (isCanceled()) {
      break;
    }

    scrollCount++;

    // 报告进度
    if (onProgress) {
      onProgress({
        scrollCount,
        maxScrollTimes,
        noNewContentCount,
        phase: 'scrolling',
        message: `正在向下滚动... (第 ${scrollCount} 次)`,
      });
    }

    // 获取当前内容数量
    let currentContentCount = previousContentCount;
    if (detectNewContent) {
      try {
        currentContentCount = await detectNewContent();
        checkpointActiveClock();
      } catch (error) {
        console.error('[Scroll] Detect content failed:', error);
      }
    }

    // 检查是否有新内容
    if (currentContentCount > previousContentCount) {
      noNewContentCount = 0;
      previousContentCount = currentContentCount;

      if (onProgress) {
        onProgress({
          scrollCount,
          currentContentCount,
          phase: 'found_new',
          message: `发现新卡片! 当前已嗅探 ${currentContentCount} 条`,
        });
      }
    } else {
      noNewContentCount++;

      if (onProgress) {
        onProgress({
          scrollCount,
          noNewContentCount,
          phase: 'no_new',
          message: hasFixedNoNewThreshold
            ? `未发现新内容 (${noNewContentCount}/${noNewContentThreshold})`
            : `未发现新内容 (${noNewContentCount} 次)`,
        });
      }

      // 连续多次无新内容，停止滚动
      if (hasFixedNoNewThreshold && noNewContentCount >= noNewContentThreshold) {
        stopReason = 'no_new';
        if (onProgress) {
          onProgress({
            scrollCount,
            phase: 'done',
            message: `已到达底部，共采集 ${currentContentCount} 条`,
          });
        }
        break;
      }
    }

    if (maxDurationMs > 0 && getActiveElapsedMs() >= maxDurationMs) {
      stopReason = 'max_duration';
      if (onProgress) {
        onProgress({
          scrollCount,
          phase: 'max_duration',
          message: '达到最大采集时长，停止采集',
          elapsedMs: getActiveElapsedMs(),
        });
      }
      break;
    }

    if (
      await shouldStopNow({
        scrollCount,
        currentContentCount,
        noNewContentCount,
      })
    ) {
      break;
    }

    // 随机滚动（可由调用方覆盖）
    try {
      if (typeof scrollStep === 'function') {
        await runCaptureStepWithTimeout(
          () =>
            scrollStep({
              scrollCount,
              currentContentCount,
              noNewContentCount,
              elapsedMs: getActiveElapsedMs(),
            }),
          Math.max(1000, Number(stepTimeoutMs) || CAPTURE_STEP_TIMEOUT_MS),
        );
      } else {
        await runCaptureStepWithTimeout(
          () => randomScroll(),
          Math.max(1000, Number(stepTimeoutMs) || CAPTURE_STEP_TIMEOUT_MS),
        );
      }
      checkpointActiveClock();
    } catch (error) {
      if (error?.code !== 'CAPTURE_STEP_TIMEOUT') {
        throw error;
      }
      stopReason = 'step_timeout';
      if (onProgress) {
        onProgress({
          scrollCount,
          phase: 'capture_stalled',
          message: '检测到页面滚动卡住，已停止旧步骤并保留当前采集结果',
          currentContentCount,
          elapsedMs: getActiveElapsedMs(),
        });
      }
      break;
    }

    if (detectNewContent) {
      try {
        currentContentCount = await detectNewContent();
        checkpointActiveClock();
        if (currentContentCount > previousContentCount) {
          noNewContentCount = 0;
          previousContentCount = currentContentCount;
        }
      } catch (error) {
        console.error('[Scroll] Detect content after scroll failed:', error);
      }
    }

    if (
      await shouldStopNow({
        scrollCount,
        currentContentCount,
        noNewContentCount,
      })
    ) {
      break;
    }

    // 随机等待（模拟人类行为）
    const beforeWaitNetworkPause = await waitForNetworkRecovery(onProgress);
    pausedDurationMs += beforeWaitNetworkPause.pausedDurationMs;
    checkpointActiveClock({skipGapAccounting: true});
    if (beforeWaitNetworkPause.timedOut) {
      stopReason = 'network_timeout';
      break;
    }
    if (isCanceled()) {
      break;
    }

    const plannedWaitMs = Math.floor(
      Math.random() * (Math.max(waitMinMs, waitMaxMs) - Math.min(waitMinMs, waitMaxMs) + 1)
    ) + Math.min(waitMinMs, waitMaxMs);
    if (onProgress) {
      onProgress({
        scrollCount,
        phase: 'waiting',
        message: `触发防反爬挂起，模拟人类等待 (${(plannedWaitMs / 1000).toFixed(2)}s)`,
        waitMs: plannedWaitMs,
      });
    }

    await wait(plannedWaitMs);
    checkpointActiveClock();

    // 检查是否被取消
    if (isCanceled()) {
      if (onProgress) {
        onProgress({
          scrollCount,
          phase: 'canceled',
          message: `采集已取消，保存当前进度 (${currentContentCount} 条)`,
        });
      }
      break;
    }
  }

  // 检查是否达到最大滚动次数
  if (scrollCount >= maxScrollTimes && !isCanceled()) {
    if (!stopReason) {
      stopReason = 'max_scroll';
    }
    if (onProgress) {
      onProgress({
        scrollCount,
        phase: 'max_reached',
        message: `已达到最大滚动次数 (${maxScrollTimes})，停止采集`,
      });
    }
  }

  return {
    completed:
      !isCanceled() &&
      hasFixedNoNewThreshold &&
      noNewContentCount >= noNewContentThreshold,
    canceled: isCanceled(),
    scrollCount,
    maxScrollTimes,
    noNewContentCount,
    finalContentCount: previousContentCount,
    stopReason:
      stopReason ||
      (hasFixedNoNewThreshold && noNewContentCount >= noNewContentThreshold
        ? 'no_new'
        : ''),
    elapsedMs: getActiveElapsedMs(),
    pausedDurationMs,
    stalled:
      stopReason === 'step_timeout' || stopReason === 'network_timeout',
    networkTimedOut: stopReason === 'network_timeout',
  };
}

// ==================== 智能等待 ====================

/**
 * 智能等待直到满足条件
 * @param {Function} condition - 条件函数
 * @param {Object} options - 配置选项
 * @param {number} options.timeout - 超时时间（毫秒）
 * @param {number} options.interval - 检查间隔（毫秒）
 * @returns {Promise<boolean>} 是否满足条件
 */
export async function waitUntil(
  condition,
  { timeout = 5000, interval = 100 } = {}
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout && !isCanceled()) {
    try {
      const result = await condition();
      if (result) {
        return true;
      }
    } catch (error) {
      console.warn('[Scroll] Condition check failed:', error);
    }

    await wait(interval);
  }

  return false;
}

/**
 * 等待网络空闲（所有请求完成）
 * @param {number} idleTime - 空闲时间（毫秒）
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
export async function waitForNetworkIdle(idleTime = 500, timeout = 10000) {
  let lastRequestTime = Date.now();
  const observer = new PerformanceObserver((list) => {
    lastRequestTime = Date.now();
  });

  try {
    observer.observe({ entryTypes: ['resource'] });

    await waitUntil(
      () => Date.now() - lastRequestTime >= idleTime,
      { timeout, interval: 100 }
    );
  } finally {
    observer.disconnect();
  }
}

// ==================== 可见性检查 ====================

/**
 * 检查元素是否在视口中
 * @param {Element} element - 目标元素
 * @returns {boolean} 是否在视口中
 */
export function isElementInView(element) {
  if (!element) return false;

  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
}

/**
 * 获取视口内的元素
 * @param {Array<Element>} elements - 元素数组
 * @returns {Array<Element>} 视口内的元素
 */
export function getElementsInView(elements) {
  return elements.filter((element) => isElementInView(element));
}

/**
 * 滚动使元素进入视口中心
 * @param {Element} element - 目标元素
 * @returns {Promise<void>}
 */
export async function scrollElementIntoView(element) {
  if (!element) return;

  const rect = element.getBoundingClientRect();
  const targetY = window.scrollY + rect.top - window.innerHeight / 2;

  await smoothScrollTo(targetY);
}
