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
  return new Promise((resolve) => {
    const startY = window.scrollY;
    const distance = targetY - startY;
    const startTime = Date.now();

    function scroll() {
      if (isCanceled()) {
        resolve();
        return;
      }

      const currentTime = Date.now();
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // 缓动函数（easeInOutQuad）
      const easeProgress =
        progress < 0.5
          ? 2 * progress * progress
          : -1 + (4 - 2 * progress) * progress;

      window.scrollTo(0, startY + distance * easeProgress);

      if (progress < 1) {
        requestAnimationFrame(scroll);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(scroll);
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
  return new Promise((resolve) => {
    const checkInterval = 100; // 每100ms检查一次取消标志
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += checkInterval;

      if (isCanceled()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, checkInterval);
  });
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
} = {}) {
  let scrollCount = 0;
  let noNewContentCount = 0;
  let previousContentCount = 0;
  let stopReason = '';
  const startedAt = Date.now();
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
        elapsedMs: Date.now() - startedAt,
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
        elapsedMs: Date.now() - startedAt,
      });
    }
    return true;
  };

  // 重置取消标志
  resetCancelFlag();

  while (scrollCount < maxScrollTimes && !isCanceled()) {
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

    if (maxDurationMs > 0 && Date.now() - startedAt >= maxDurationMs) {
      stopReason = 'max_duration';
      if (onProgress) {
        onProgress({
          scrollCount,
          phase: 'max_duration',
          message: '达到最大采集时长，停止采集',
          elapsedMs: Date.now() - startedAt,
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
    if (typeof scrollStep === 'function') {
      await scrollStep({
        scrollCount,
        currentContentCount,
        noNewContentCount,
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      await randomScroll();
    }

    if (detectNewContent) {
      try {
        currentContentCount = await detectNewContent();
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
    elapsedMs: Date.now() - startedAt,
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
