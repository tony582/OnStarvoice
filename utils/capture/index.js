/**
 * onstarvoice V2.0 Capture Module Entry Point
 * 统一导出所有采集函数
 */

import { xiaohongshuAdapter } from './adapters/xiaohongshu/index.js';
import { douyinAdapter } from './adapters/douyin/index.js';
import { PAGE_TYPE, SYNC_TYPE } from '../constants.js';
import { detectPageType, detectPlatformFromUrl } from '../platform/page-routing.js';

const ADAPTERS = {
  xiaohongshu: xiaohongshuAdapter,
  douyin: douyinAdapter,
};

function getCurrentAdapter() {
  const platform = detectPlatformFromUrl(window.location.href);
  return ADAPTERS[platform] || xiaohongshuAdapter;
}

function buildUnsupportedCaptureResult(type, platform, message) {
  const captureFinishedAt = new Date().toISOString();
  return {
    ok: false,
    platform,
    type,
    data: null,
    meta: {
      pageType: detectPageType(window.location.href, platform),
      captureStartedAt: captureFinishedAt,
      captureFinishedAt,
      sourceUrl: window.location.href,
    },
    error: {
      code: 'CAPTURE_UNSUPPORTED',
      message,
    },
  };
}

async function invokeAdapterCapture(methodName, type, options) {
  const adapter = getCurrentAdapter();
  const method = adapter?.[methodName];

  if (typeof method !== 'function') {
    return buildUnsupportedCaptureResult(
      type,
      adapter?.platform || 'unknown',
      '当前平台暂不支持该采集能力',
    );
  }

  return method(options);
}

export async function captureSingleNote(options = {}) {
  return invokeAdapterCapture('captureSingleNote', SYNC_TYPE.SINGLE_NOTE, options);
}

export async function captureBloggerProfile() {
  return invokeAdapterCapture('captureBloggerProfile', SYNC_TYPE.BLOGGER_PROFILE);
}

export async function captureBloggerNotes(options = {}) {
  return invokeAdapterCapture('captureBloggerNotes', SYNC_TYPE.BLOGGER_NOTES, options);
}

export async function captureKeywordNotes(options = {}) {
  return invokeAdapterCapture('captureKeywordNotes', SYNC_TYPE.KEYWORD_NOTES, options);
}

export async function captureComments(options = {}) {
  return invokeAdapterCapture('captureComments', SYNC_TYPE.COMMENTS, options);
}

export const detectKeywordSortDimension = (...args) =>
  getCurrentAdapter().detectKeywordSortDimension?.(...args) ||
  xiaohongshuAdapter.detectKeywordSortDimension?.(...args) || {
    dimension: "likes",
    source: "default",
  };

/**
 * 智能采集：根据当前页面类型自动选择采集函数
 * @param {Object} options - 配置选项
 * @param {string} options.mode - 采集模式（'auto', 'single', 'blogger_profile', 'blogger_notes', 'keyword', 'comments'）
 * @param {Function} options.onProgress - 进度回调
 * @returns {Promise<Object>} 采集结果
 */
export async function smartCapture({ mode = 'auto', onProgress = null } = {}) {
  try {
    const adapter = getCurrentAdapter();

    // 自动模式：检测页面类型
    if (mode === 'auto') {
      const pageType = adapter.detectPageType(window.location.href);

      switch (pageType) {
        case PAGE_TYPE.NOTE_DETAIL:
          return await captureSingleNote();

        case PAGE_TYPE.BLOGGER_PROFILE:
          // 默认采集博主信息+笔记列表
          const profileResult = await captureBloggerProfile();
          if (!profileResult.ok) {
            return profileResult;
          }

          const notesResult = await captureBloggerNotes({ onProgress });
          return notesResult;

        case PAGE_TYPE.SEARCH_RESULTS:
          return await captureKeywordNotes({ onProgress });

        case PAGE_TYPE.UNSUPPORTED:
          throw new Error('当前页面类型不支持采集');

        default:
          throw new Error('无法识别页面类型');
      }
    }

    // 手动模式：根据指定模式采集
    switch (mode) {
      case 'single':
        return await captureSingleNote();

      case 'blogger_profile':
        return await captureBloggerProfile();

      case 'blogger_notes':
        return await captureBloggerNotes({ onProgress });

      case 'keyword':
        return await captureKeywordNotes({ onProgress });

      case 'comments':
        return await captureComments({ onProgress });

      default:
        throw new Error(`未知的采集模式: ${mode}`);
    }
  } catch (error) {
    console.error('[Capture] Smart capture failed:', error);

    return {
      ok: false,
      platform: detectPlatformFromUrl(window.location.href),
      type: null,
      data: null,
      meta: {
        pageType: detectPageType(window.location.href),
        captureStartedAt: new Date().toISOString(),
        captureFinishedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
      },
      error: {
        code: 'SMART_CAPTURE_FAILED',
        message: error.message,
      },
    };
  }
}

/**
 * 批量采集：采集多个目标
 * @param {Array<Object>} targets - 目标数组
 * @param {Object} options - 配置选项
 * @param {Function} options.onProgress - 进度回调
 * @param {number} options.delayBetween - 每个目标之间的延迟（毫秒）
 * @returns {Promise<Array<Object>>} 采集结果数组
 */
export async function batchCapture(
  targets,
  { onProgress = null, delayBetween = 2000 } = {}
) {
  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];

    if (onProgress) {
      onProgress({
        phase: 'batch_progress',
        current: i + 1,
        total: targets.length,
        message: `正在采集第 ${i + 1}/${targets.length} 个目标...`,
      });
    }

    try {
      const result = await smartCapture({
        mode: target.mode || 'auto',
        onProgress,
      });

      results.push({
        target,
        result,
        success: result.ok,
      });
    } catch (error) {
      results.push({
        target,
        result: null,
        success: false,
        error: error.message,
      });
    }

    // 延迟（除了最后一个）
    if (i < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayBetween));
    }
  }

  return results;
}

/**
 * 验证采集结果
 * @param {Object} result - 采集结果
 * @returns {boolean} 是否有效
 */
export function validateCaptureResult(result) {
  if (!result || typeof result !== 'object') {
    return false;
  }

  // 必须字段
  if (
    typeof result.ok !== 'boolean' ||
    !result.meta ||
    typeof result.meta !== 'object'
  ) {
    return false;
  }

  // 如果成功，必须有 data 和 type
  if (result.ok) {
    if (!result.data || !result.type) {
      return false;
    }

    // 验证 type 是否有效
    const validTypes = Object.values(SYNC_TYPE);
    if (!validTypes.includes(result.type)) {
      return false;
    }
  }

  // 如果失败，必须有 error
  if (!result.ok && !result.error) {
    return false;
  }

  return true;
}

/**
 * 格式化采集结果为日志
 * @param {Object} result - 采集结果
 * @returns {string} 格式化的日志
 */
export function formatCaptureResult(result) {
  if (!result) {
    return '[Capture] Invalid result';
  }

  const { ok, type, data, meta, error } = result;

  if (ok) {
    let summary = `[Capture] Success: ${type}`;

    // 根据类型添加详情
    switch (type) {
      case SYNC_TYPE.SINGLE_NOTE:
        summary += ` | Note: ${data.title}`;
        break;

      case SYNC_TYPE.BLOGGER_PROFILE:
        summary += ` | Blogger: ${data.bloggerName}`;
        break;

      case SYNC_TYPE.BLOGGER_NOTES:
        summary += ` | Count: ${data.totalCount}`;
        break;

      case SYNC_TYPE.KEYWORD_NOTES:
        summary += ` | Keyword: ${data.keyword} | Count: ${data.totalCount}`;
        break;

      case SYNC_TYPE.COMMENTS:
        summary += ` | Count: ${data.totalCount}`;
        break;
    }

    // 添加滚动信息
    if (meta.scrollInfo) {
      summary += ` | Scrolls: ${meta.scrollInfo.scrollCount}`;
    }

    return summary;
  } else {
    return `[Capture] Failed: ${error?.code || 'UNKNOWN'} | ${error?.message || 'No error message'}`;
  }
}
