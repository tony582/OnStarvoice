/**
 * onstarvoice V2.0 Helper Functions
 * 通用工具函数
 */

import { NOTE_TYPE } from './constants.js';
import {
  detectPageType as detectPageTypeFromRouting,
  detectPlatformFromUrl as detectPlatformFromRouting,
} from './platform/page-routing.js';

// ==================== URL 相关 ====================

/**
 * 检测当前页面类型
 * @param {string} url - 页面 URL
 * @returns {string} 页面类型
 */
export function detectPageType(url) {
  return detectPageTypeFromRouting(url);
}

/**
 * 根据 URL 检测平台类型
 * @param {string} url
 * @returns {'xiaohongshu' | 'douyin' | 'unknown'}
 */
export function detectPlatformFromUrl(url) {
  return detectPlatformFromRouting(url);
}

/**
 * 从 URL 提取笔记 ID
 */
export function extractNoteId(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return null;

  // 如果处于弹窗模式，必定以此为准
  const modalMatch = normalized.match(/[?&]modal_id=(\d+)/i);
  if (modalMatch?.[1]) {
    return modalMatch[1];
  }

  const douyinPathMatch = normalized.match(/\/(?:video|note)\/(\d+)/i);
  if (douyinPathMatch?.[1]) {
    return douyinPathMatch[1];
  }

  const pathMatch = normalized.match(
    /(?:explore\/|discovery\/item\/|note\/|video\/|search_result\/)([a-zA-Z0-9_-]+)/i
  );
  if (pathMatch?.[1]) {
    return pathMatch[1];
  }

  const profilePathMatch = normalized.match(
    /(?:user\/profile\/[a-zA-Z0-9_-]+\/)([a-zA-Z0-9_-]+)/i
  );
  if (profilePathMatch?.[1]) {
    return profilePathMatch[1];
  }

  const queryMatch = normalized.match(/[?&](?:note_id|noteId|id)=([a-zA-Z0-9_-]+)/i);
  if (queryMatch?.[1]) {
    return queryMatch[1];
  }

  return null;
}

/**
 * 从 URL 提取博主 ID
 */
export function extractBloggerId(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return null;

  const xhsMatch = normalized.match(/user\/profile\/([a-zA-Z0-9]+)/i);
  if (xhsMatch?.[1]) return xhsMatch[1];

  const douyinMatch = normalized.match(/\/user\/([a-zA-Z0-9._-]+)/i);
  if (douyinMatch?.[1]) return douyinMatch[1];

  return null;
}

/**
 * 从 URL 提取用户 ID（extractBloggerId 的别名）
 */
export function extractUserId(url) {
  return extractBloggerId(url);
}

// ==================== 数据清洗 ====================

/**
 * 解析点赞数/收藏数等互动数据
 * 支持: "1.2K", "1.2万", "10", "1234" 等格式
 */
export function parseInteractionCount(str) {
  if (!str) return 0;

  const text = String(str).trim();

  // 处理 "1.2K" 格式
  if (text.includes('K') || text.includes('k')) {
    const num = parseFloat(text.replace(/[Kk]/g, ''));
    return Math.round(num * 1000);
  }

  // 处理 "1.2万" 格式
  if (text.includes('万')) {
    const num = parseFloat(text.replace('万', ''));
    return Math.round(num * 10000);
  }

  // 处理纯数字
  const num = parseInt(text.replace(/,/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

/**
 * 标准化日期格式（增强版）
 * @param {string} dateStr - 原始日期字符串
 * @returns {string} YYYY-MM-DD 格式
 */
export function normalizeDate(dateStr) {
  if (!dateStr) {
    return getCurrentDateString();
  }

  try {
    const str = String(dateStr).trim();

    // 处理 ISO 8601 格式 (2024-03-05T10:30:00Z)
    if (str.includes('T') && str.includes(':')) {
      const date = new Date(str);
      if (!isNaN(date.getTime())) {
        return formatDate(date);
      }
    }

    // 处理 "刚刚"
    if (str === '刚刚' || str.includes('刚刚')) {
      return formatDate(new Date());
    }

    const now = new Date();

    // 处理 "N分钟前"
    if (str.includes('分钟前')) {
      const minutes = parseInt(str);
      if (!isNaN(minutes)) {
        now.setMinutes(now.getMinutes() - minutes);
        return formatDate(now);
      }
    }

    // 处理 "N小时前"
    if (str.includes('小时前')) {
      const hours = parseInt(str);
      if (!isNaN(hours)) {
        now.setHours(now.getHours() - hours);
        return formatDate(now);
      }
    }

    // 处理 "昨天"
    if (str === '昨天' || str.includes('昨天')) {
      now.setDate(now.getDate() - 1);
      return formatDate(now);
    }

    // 处理 "N天前"
    if (str.includes('天前')) {
      const days = parseInt(str);
      if (!isNaN(days)) {
        now.setDate(now.getDate() - days);
        return formatDate(now);
      }
    }

    // 处理 "YYYY年MM月DD日" 格式
    const fullChineseDateMatch = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (fullChineseDateMatch) {
      const year = Number(fullChineseDateMatch[1]);
      const month = Number(fullChineseDateMatch[2]);
      const day = Number(fullChineseDateMatch[3]);
      const date = new Date(year, month - 1, day);
      if (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      ) {
        return formatDate(date);
      }
    }

    // 处理 "MM月DD日" 格式（平台常用于当年内容）
    const chineseMonthDayMatch = str.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (chineseMonthDayMatch) {
      const month = Number(chineseMonthDayMatch[1]);
      const day = Number(chineseMonthDayMatch[2]);
      let year = now.getFullYear();
      let date = new Date(year, month - 1, day);
      if (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      ) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (date.getTime() > tomorrow.getTime()) {
          year -= 1;
          date = new Date(year, month - 1, day);
        }
        return formatDate(date);
      }
    }

    // 处理 "MM-DD" 格式（补充年份）
    if (/^\d{1,2}-\d{1,2}$/.test(str)) {
      const [month, day] = str.split('-').map(Number);
      let year = now.getFullYear();
      let date = new Date(year, month - 1, day);
      if (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      ) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (date.getTime() > tomorrow.getTime()) {
          year -= 1;
          date = new Date(year, month - 1, day);
        }
        return formatDate(date);
      }
    }

    // 处理 "YYYY-MM-DD" 格式
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(str)) {
      const date = new Date(str);
      if (!isNaN(date.getTime())) {
        return formatDate(date);
      }
    }

    // 尝试直接解析
    const date = new Date(str);
    if (!isNaN(date.getTime()) && date.getFullYear() > 2000) {
      return formatDate(date);
    }

    // 所有策略失败，返回当前日期
    return getCurrentDateString();
  } catch (error) {
    return getCurrentDateString();
  }
}

/**
 * 获取当前日期字符串
 */
function getCurrentDateString() {
  return formatDate(new Date());
}

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date) {
  if (!date || isNaN(date.getTime())) {
    return getCurrentDateString();
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 清洗标签数组
 */
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0 && tag !== '#');
}

/**
 * 清洗图片 URL 列表
 */
export function cleanImageUrls(urls) {
  if (!Array.isArray(urls)) return [];
  return urls.filter((url) => url && url.startsWith('http'));
}

// ==================== 文本处理 ====================

/**
 * 清洗文本（去除多余空白，trim）
 */
export function cleanText(text) {
  if (!text) return '';
  return normalizeWhitespace(String(text).trim());
}

/**
 * 截断文本为指定长度
 */
export function truncateText(text, maxLength = 100) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * 移除多余空白字符
 */
export function normalizeWhitespace(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 提取纯文本内容（移除 HTML 标签）
 */
export function stripHtml(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

// ==================== UUID 生成 ====================

/**
 * 生成简单的 UUID v4
 */
export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 生成客户端标签
 */
export function generateClientLabel() {
  const browser = getBrowserInfo();
  const os = getOSInfo();
  return `${browser} on ${os}`;
}

/**
 * 获取浏览器信息
 */
function getBrowserInfo() {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  if (ua.includes('Firefox/')) return 'Firefox';
  return 'Unknown';
}

/**
 * 获取操作系统信息
 */
function getOSInfo() {
  const ua = navigator.userAgent;
  if (ua.includes('Win')) return 'Windows';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Linux')) return 'Linux';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('iOS')) return 'iOS';
  return 'Unknown';
}

// ==================== 时间相关 ====================

/**
 * 获取当前时间戳（毫秒）
 */
export function now() {
  return Date.now();
}

/**
 * 格式化时间戳为可读字符串
 */
export function formatTimestamp(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 计算相对时间（如 "2分钟前"）
 */
export function getRelativeTime(timestamp) {
  if (!timestamp) return '';

  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (minutes > 0) return `${minutes}分钟前`;
  return '刚刚';
}

// ==================== 数据验证 ====================

/**
 * 检查是否为有效的 URL
 */
export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查是否为有效的小红书 URL
 */
export function isXhsUrl(url) {
  return url && url.includes('xiaohongshu.com');
}

// ==================== 随机延迟 ====================

/**
 * 生成随机延迟（用于模拟人类操作）
 */
export function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 生成随机滚动距离
 */
export function randomScrollDistance(min = 300, max = 800) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==================== DOM 相关 ====================

/**
 * 安全获取元素文本内容
 */
export function safeGetText(element, selector = null) {
  try {
    const target = selector ? element.querySelector(selector) : element;
    return target ? normalizeWhitespace(target.textContent) : '';
  } catch {
    return '';
  }
}

/**
 * 安全获取元素属性
 */
export function safeGetAttribute(element, attribute) {
  try {
    return element ? element.getAttribute(attribute) || '' : '';
  } catch {
    return '';
  }
}

/**
 * 等待元素出现
 */
export function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element not found: ${selector}`));
    }, timeout);
  });
}

// ==================== 导出数据 ====================

/**
 * 下载 JSON 文件
 */
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, filename);
}

/**
 * 下载 CSV 文件
 */
export function downloadCSV(data, filename) {
  // data 应该是二维数组: [[header1, header2], [value1, value2], ...]
  const csv = data.map((row) => row.join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

/**
 * 下载 Blob
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==================== 错误处理 ====================

/**
 * 创建标准化错误对象
 */
export function createError(code, message, details = null) {
  return {
    code,
    message,
    details,
    timestamp: Date.now(),
  };
}

/**
 * 安全执行函数
 */
export async function safeExecute(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.error('[Helpers] Safe execute failed:', error);
    return fallback;
  }
}
