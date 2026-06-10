/**
 * 微博平台采集适配器
 * Phase 1: 仅支持搜索页采集
 */
import { captureWeiboKeywordNotes } from "../../weibo-keyword-search.js";
import { detectPageType } from "../../../platform/page-routing.js";
import { SYNC_TYPE } from "../../../constants.js";

function normalizeCaptureResult(result, type) {
  const normalized = result && typeof result === "object" ? result : {};
  const meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};

  return {
    ...normalized,
    platform: "weibo",
    type: normalized.type || type || null,
    meta: {
      ...meta,
      pageType: meta.pageType || detectPageType(window.location.href, "weibo"),
      sourceUrl: meta.sourceUrl || window.location.href,
    },
  };
}

function buildUnsupportedResult(type, message) {
  const now = new Date().toISOString();
  return {
    ok: false,
    platform: "weibo",
    type,
    data: null,
    meta: {
      pageType: detectPageType(window.location.href, "weibo"),
      captureStartedAt: now,
      captureFinishedAt: now,
      sourceUrl: window.location.href,
    },
    error: {
      code: "CAPTURE_UNSUPPORTED",
      message,
    },
  };
}

export const weiboAdapter = {
  platform: "weibo",

  detectPageType(url) {
    return detectPageType(url, "weibo");
  },

  async captureSingleNote() {
    return buildUnsupportedResult(
      SYNC_TYPE.SINGLE_NOTE,
      "微博详情页采集功能开发中，敬请期待",
    );
  },

  async captureBloggerProfile() {
    return buildUnsupportedResult(
      SYNC_TYPE.BLOGGER_PROFILE,
      "微博用户页采集功能开发中，敬请期待",
    );
  },

  async captureBloggerNotes(options = {}) {
    return buildUnsupportedResult(
      SYNC_TYPE.BLOGGER_NOTES,
      "微博用户微博列表采集功能开发中，敬请期待",
    );
  },

  async captureKeywordNotes(options = {}) {
    return normalizeCaptureResult(
      await captureWeiboKeywordNotes(options),
      SYNC_TYPE.KEYWORD_NOTES,
    );
  },

  async captureComments(options = {}) {
    return buildUnsupportedResult(
      SYNC_TYPE.COMMENTS,
      "微博评论采集功能开发中，敬请期待",
    );
  },

  detectKeywordSortDimension() {
    return { dimension: "likes", source: "weibo_default" };
  },
};
